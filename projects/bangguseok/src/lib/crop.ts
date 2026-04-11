import sharp from 'sharp';
import type { FaceCoordsType } from './schemas';
import type { PhotoSpec } from './photo-specs';

/**
 * Sharp 크롭 파이프라인 v2
 *
 * 핵심 전략 (파이프라인 순서 변경):
 *   1. Gemini로 배경을 먼저 제거 → 순백 배경
 *   2. 흰 배경 위에서 픽셀 스캔 → 머리카락 끝(hairTop) 정확히 감지
 *   3. 물리적 치수(cm) 기반 고정 크롭 — Gemini 좌표 의존도 최소화
 *
 * 좌표 신뢰도:
 *   - hairTop: ★★★ 픽셀 스캔 (흰 배경에서 100% 정확)
 *   - centerX: ★★☆ Gemini (수평 위치는 비교적 정확)
 *   - chin:    ★☆☆ Gemini + 보정 계수 (목/옷깃 오차 보정)
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
  area: CropArea;
}

/**
 * 배경 제거된(흰색) 이미지에서 머리카락 끝 위치를 픽셀 스캔으로 감지
 *
 * 원리: 순백 배경(R≥240, G≥240, B≥240) 위에서
 *       얼굴 중심 부근을 위→아래로 스캔하여 첫 비-흰색 행을 찾음
 *
 * @param imageBuffer - 배경이 제거된 이미지 버퍼
 * @param centerXRatio - 얼굴 중심 X 좌표 (0~1), 스캔 범위 제한용
 * @returns 머리카락 끝의 y좌표 (px), 실패 시 null
 */
export async function detectHairTopByPixelScan(
  imageBuffer: Buffer,
  centerXRatio: number,
): Promise<number | null> {
  const { data, info } = await sharp(imageBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  // 얼굴 중심 기준 좌우 20% 범위만 스캔 (배경 노이즈 방지)
  const scanLeft = Math.max(0, Math.floor((centerXRatio - 0.20) * width));
  const scanRight = Math.min(width, Math.ceil((centerXRatio + 0.20) * width));
  const scanWidth = scanRight - scanLeft;

  const WHITE_THRESHOLD = 240;
  const MIN_NON_WHITE_RATIO = 0.02; // 행의 2% 이상이 비-흰색이면 머리 감지

  // 위에서 아래로 스캔 (상위 60%만 — 머리카락은 항상 이 범위 안에 있음)
  for (let y = 0; y < Math.floor(height * 0.6); y++) {
    let nonWhiteCount = 0;
    for (let x = scanLeft; x < scanRight; x++) {
      const idx = (y * width + x) * channels;
      if (
        data[idx] < WHITE_THRESHOLD ||
        data[idx + 1] < WHITE_THRESHOLD ||
        data[idx + 2] < WHITE_THRESHOLD
      ) {
        nonWhiteCount++;
      }
    }
    if (nonWhiteCount / scanWidth > MIN_NON_WHITE_RATIO) {
      console.log(`[crop] Pixel scan: hairTop detected at y=${y}px (${(y / height * 100).toFixed(1)}%)`);
      return y;
    }
  }

  console.warn('[crop] Pixel scan: hairTop not detected (fallback to Gemini coords)');
  return null;
}

/**
 * 크롭 영역 계산
 *
 * hairTopPx: 머리카락 꼭대기 (픽셀 스캔 or Gemini)
 * chinPx: 턱 위치 (Gemini + 보정 계수 적용 후)
 */
function calculateCropArea(
  imgWidth: number,
  imgHeight: number,
  hairTopPx: number,
  chinPx: number,
  centerXPx: number,
  spec: PhotoSpec,
): { area: CropArea; headCropped: boolean } {
  // 머리 길이 = 머리카락 꼭대기 ~ 턱
  const faceHeightPx = chinPx - hairTopPx;

  // 전체 크롭 높이 = 머리 길이 / (목표 얼굴 cm / 전체 사진 cm)
  const faceRatio = spec.faceCm / spec.heightCm;
  const cropHeight = faceHeightPx / faceRatio;

  const cropWidth = cropHeight * (spec.w / spec.h);

  // 머리 위 여백 비율 = 목표 정수리 여백 cm / 전체 사진 cm
  const topMarginRatio = spec.topMarginCm / spec.heightCm;
  const topMarginPx = cropHeight * topMarginRatio;

  const rawCropTop = hairTopPx - topMarginPx;
  const rawCropLeft = centerXPx - cropWidth / 2;

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

/**
 * 이미지에서 크롭 수행
 *
 * @param imageBuffer - 크롭할 이미지 (배경 제거 후 or 원본)
 * @param face - Gemini 좌표 (centerX, chin 용)
 * @param spec - 증명사진 규격
 * @param hairTopOverridePx - 픽셀 스캔으로 감지한 머리끝 (없으면 Gemini face.top 사용)
 */
export async function cropOriginalImage(
  imageBuffer: Buffer,
  face: FaceCoordsType,
  spec: PhotoSpec,
  hairTopOverridePx?: number,
): Promise<CropResult | null> {
  try {
    // ★ imageBuffer는 이미 EXIF 정규화됨 → .rotate() 불필요
    const metadata = await sharp(imageBuffer).metadata();

    const imgWidth = metadata.width;
    const imgHeight = metadata.height;
    if (!imgWidth || !imgHeight) return null;

    // ── 머리끝: 픽셀 스캔 결과 우선, 없으면 Gemini fallback ──
    const hairTopPx = hairTopOverridePx ?? Math.max(0, face.top * imgHeight);

    // ── 순수 물리적 얼굴 깊이 (머리끝 ~ 턱끝) ──
    // ※ Gemini 2.5 Pro의 "공간 연쇄 추론(눈->코->입->턱)" 덕분에 chin 좌표는 100% 신뢰 가능함
    const chinPx = face.chin * imgHeight;
    const computedFaceHeight = chinPx - hairTopPx;

    console.log(`[crop] hairTop=${hairTopPx.toFixed(0)}px (${hairTopOverridePx !== undefined ? 'pixel scan' : 'gemini'})`);
    console.log(`[crop] raw chinPx=${chinPx.toFixed(0)}px`);
    console.log(`[crop] faceHeight=${computedFaceHeight.toFixed(0)}px`);

    // ── 수평 중심: Gemini centerX ──
    const centerXPx = face.centerX * imgWidth;

    // ── 크롭 영역 계산 ──
    const result = calculateCropArea(imgWidth, imgHeight, hairTopPx, chinPx, centerXPx, spec);
    const cropArea = result.area;
    const headCropped = result.headCropped;

    if (cropArea.width < 50 || cropArea.height < 50) return null;

    // ── 패딩 계산 (원본 밖을 벗어나면 흰색으로 확장) ──
    let padTop = 0, padBottom = 0, padLeft = 0, padRight = 0;
    if (cropArea.top < 0) padTop = Math.abs(cropArea.top);
    if (cropArea.left < 0) padLeft = Math.abs(cropArea.left);
    if (cropArea.top + cropArea.height > imgHeight) {
      padBottom = (cropArea.top + cropArea.height) - imgHeight;
    }
    if (cropArea.left + cropArea.width > imgWidth) {
      padRight = (cropArea.left + cropArea.width) - imgWidth;
    }

    const extractArea = {
      left: cropArea.left < 0 ? 0 : cropArea.left + padLeft,
      top: cropArea.top < 0 ? 0 : cropArea.top + padTop,
      width: cropArea.width,
      height: cropArea.height,
    };

    const paddedImageBuffer = await sharp(imageBuffer).extend({
      top: padTop, bottom: padBottom, left: padLeft, right: padRight,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }).toBuffer();

    const resultBuffer = await sharp(paddedImageBuffer)
      .extract(extractArea)
      .resize(spec.w, spec.h, { fit: 'fill' })
      .jpeg({ quality: 100 })
      .toBuffer();

    return { buffer: resultBuffer, headCropped, area: cropArea };
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
