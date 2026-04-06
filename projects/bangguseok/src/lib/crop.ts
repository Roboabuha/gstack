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
  actualHairTop: number,
  face: FaceCoordsType,
  spec: PhotoSpec,
): { area: CropArea; headCropped: boolean } {
  const faceChinPx = face.chin * imgHeight;
  const faceCenterXPx = face.centerX * imgWidth;

  const faceHeightPx = faceChinPx - actualHairTop;

  // 1. 표준 크롭 계산 (예: 350x450 기준)
  const standardCropHeight = faceHeightPx / spec.faceRatio;
  const standardCropWidth = standardCropHeight * (spec.w / spec.h);
  
  const standardTopMargin = standardCropHeight * 0.03;
  const standardCropTop = actualHairTop - standardTopMargin;
  const standardCropLeft = faceCenterXPx - standardCropWidth / 2;

  // 2. 캔버스용 넉넉한 세로 크롭 확장 (가로는 고정, 세로는 600px 비율로)
  // 프론트엔드가 350x600 크기를 받아서 350x450 창틀 안에서 움직일 수 있도록 조치
  const generousWidth = standardCropWidth;
  const generousHeight = generousWidth * (600 / spec.w); // e.g. 350 : 600

  const extraHeight = generousHeight - standardCropHeight;
  // 여유 공간을 위쪽에 40%, 아랫쪽에 60% 배분 (아래쪽 어깨가 더 많이 필요하므로)
  const generousCropTop = standardCropTop - (extraHeight * 0.4);
  const generousCropLeft = standardCropLeft;

  const headCropped = generousCropTop < 0; // 이젠 웬만해서 잘리지 않지만 여전히 안전장치
  return {
    area: {
      left: Math.round(generousCropLeft),
      top: Math.round(generousCropTop),
      width: Math.round(generousWidth),
      height: Math.round(generousHeight),
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
): Promise<CropResult | null> {
  try {
    const rotated = sharp(imageBuffer).rotate();
    const metadata = await rotated.metadata();

    const imgWidth = metadata.width;
    const imgHeight = metadata.height;
    if (!imgWidth || !imgHeight) return null;

    const geminiFaceTopPx = face.top * imgHeight;
    const geminiChinPx = face.chin * imgHeight;
    const actualHairTop = geminiFaceTopPx;

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
      .resize(spec.w, 600, { fit: 'fill' }) // 프론트엔드용 Generous Crop 사이즈 고정
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
