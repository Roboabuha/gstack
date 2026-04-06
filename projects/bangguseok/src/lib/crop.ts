import sharp from 'sharp';
import type { FaceCoordsType } from './schemas';
import type { PhotoSpec } from './photo-specs';

/**
 * Sharp 크롭 파이프라인
 *
 * 핵심 전략:
 *   - 머리 꼭대기: 픽셀 스캔 (흰 배경 → 머리카락 시작점을 직접 탐지)
 *   - 턱 위치: Gemini 좌표 사용
 *   - 이 조합으로 Gemini 좌표 불안정성 문제 해결
 */

interface CropArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CropResult {
  buffer: Buffer;
  headCropped: boolean;
}
/**
 * 크롭 영역 계산
 *
 * hairTopPx: Gemini가 찾은 실제 머리 꼭대기
 * face.chin: Gemini가 감지한 턱 위치
 */
function calculateCropArea(
  imgWidth: number,
  imgHeight: number,
  hairTopPx: number,
  face: FaceCoordsType,
  spec: PhotoSpec,
): { area: CropArea; headCropped: boolean } {
  const faceChinPx = face.chin * imgHeight;
  const faceCenterXPx = face.centerX * imgWidth;

  // 머리 길이 = 머리카락 꼭대기 ~ 턱
  const faceHeightPx = faceChinPx - hairTopPx;

  // 전체 크롭 높이 = 머리 길이 / faceRatio
  const cropHeight = faceHeightPx / spec.faceRatio;
  const cropWidth = cropHeight * (spec.w / spec.h);

  // 머리 위 여백: 사진 전체의 약 3% (4.5cm 기준 약 1.35mm)
  const topMargin = cropHeight * 0.03;
  const rawCropTop = hairTopPx - topMargin;
  const rawCropLeft = faceCenterXPx - cropWidth / 2;

  const headCropped = rawCropTop < 0;
  return {
    area: {
      left: Math.round(rawCropLeft),
      top: Math.round(rawCropTop),
      width: Math.round(cropWidth),
      height: Math.round(cropHeight),
    },
    headCropped,
  };
}

export interface CropResult {
  buffer: Buffer;
  headCropped: boolean;
}

/**
 * 이미지 원본 영역 계산 및 크롭 (압축 제외)
 */
export async function cropOriginalImage(
  imageBuffer: Buffer,
  face: FaceCoordsType,
  spec: PhotoSpec,
  yOffsetPercent: number = 0
): Promise<CropResult | null> {
  try {
    const rotated = sharp(imageBuffer).rotate();
    const metadata = await rotated.metadata();

    const imgWidth = metadata.width;
    const imgHeight = metadata.height;
    if (!imgWidth || !imgHeight) return null;

    const geminiFaceTopPx = face.top * imgHeight;
    const geminiChinPx = face.chin * imgHeight;
    const faceBoxHeight = geminiChinPx - geminiFaceTopPx;

    // 인간이 조절한 막대바 퍼센테이지를 반영
    const offsetPx = faceBoxHeight * (yOffsetPercent / 100);
    const actualHairTop = Math.max(0, geminiFaceTopPx + offsetPx);

    // 2) 크롭 영역 계산 (머리 잘리면 faceRatio 줄여서 재시도)
    let currentSpec = { ...spec };
    let cropArea: CropArea;
    let headCropped = false;

    for (let retry = 0; retry < 3; retry++) {
      const result = calculateCropArea(imgWidth, imgHeight, actualHairTop, face, currentSpec);
      cropArea = result.area;
      headCropped = result.headCropped;

      if (!headCropped) break;
      currentSpec = { ...currentSpec, faceRatio: currentSpec.faceRatio - 0.05 };
    }

    if (cropArea!.width < 50 || cropArea!.height < 50) return null;

    let padTop = 0, padBottom = 0, padLeft = 0, padRight = 0;
    if (cropArea!.top < 0) padTop = Math.abs(cropArea!.top);
    if (cropArea!.left < 0) padLeft = Math.abs(cropArea!.left);
    if (cropArea!.top + cropArea!.height > imgHeight) {
      padBottom = (cropArea!.top + cropArea!.height) - imgHeight;
    }
    if (cropArea!.left + cropArea!.width > imgWidth) {
      padRight = (cropArea!.left + cropArea!.width) - imgWidth;
    }

    const extractArea = {
      left: cropArea!.left < 0 ? 0 : cropArea!.left + padLeft,
      top: cropArea!.top < 0 ? 0 : cropArea!.top + padTop,
      width: cropArea!.width,
      height: cropArea!.height,
    };

    const paddedImageBuffer = await sharp(imageBuffer).rotate().extend({
      top: padTop, bottom: padBottom, left: padLeft, right: padRight,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }).toBuffer();

    const resultBuffer = await sharp(paddedImageBuffer)
      .extract(extractArea)
      .resize(spec.w, spec.h, { fit: 'fill' })
      .jpeg({ quality: 100 }) // 최고 화질
      .toBuffer();

    return { buffer: resultBuffer, headCropped };
  } catch (err) {
    console.error('[crop] Error:', err);
    return null;
  }
}

/**
 * 최종 응답을 위한 JPEG 압축
 */
export async function compressImage(
  imageBuffer: Buffer,
  spec: PhotoSpec,
): Promise<string> {
  let quality = 95;
  const MIN_QUALITY = 50;
  let fallbackBuffer: Buffer | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await sharp(imageBuffer)
      .resize(spec.w, spec.h, { fit: 'fill' }) // Gemini 변형 대비 강제 사이즈 고정
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    fallbackBuffer = result;
    if (result.byteLength / 1024 <= spec.maxKB) {
      return result.toString('base64');
    }

    quality -= 12;
    if (quality < MIN_QUALITY) break;
  }
  return fallbackBuffer!.toString('base64');
}
