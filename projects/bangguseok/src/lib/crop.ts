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
  image: string;
  headCropped: boolean;
}

/**
 * 흰 배경에서 인물(머리카락) 시작 y좌표를 픽셀 스캔으로 찾기
 *
 * 이미지 상단부터 아래로 스캔하면서, 흰색이 아닌 픽셀이
 * 일정 비율 이상 나타나는 첫 번째 행을 찾는다.
 *
 * @returns 머리카락 시작 y좌표 (px), 찾지 못하면 null
 */
async function detectHairTopByPixel(imageBuffer: Buffer): Promise<number | null> {
  try {
    const { data, info } = await sharp(imageBuffer)
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;

    // 상단 60%만 스캔 (하단은 어깨/옷이므로 무의미)
    const scanLimit = Math.floor(height * 0.6);

    for (let y = 0; y < scanLimit; y++) {
      let nonWhiteCount = 0;

      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // 흰색 기준: RGB 모두 240 이상이면 배경
        if (r < 240 || g < 240 || b < 240) {
          nonWhiteCount++;
        }
      }

      // 해당 행에서 비배경 픽셀이 3% 이상이면 → 인물 시작
      if (nonWhiteCount / width > 0.03) {
        console.log(`[crop] Hair top detected at y=${y} (${(y / height * 100).toFixed(1)}%)`);
        return y;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 크롭 영역 계산
 *
 * hairTopPx: 픽셀 스캔으로 찾은 실제 머리 꼭대기
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

/**
 * 이미지 크롭 + 리사이즈 + 압축
 */
export async function cropAndResize(
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
    const faceBoxHeight = geminiChinPx - geminiFaceTopPx;

    // 1) 픽셀 스캔으로 실제 머리 꼭대기 찾기
    let hairTopPx = await detectHairTopByPixel(imageBuffer);
    
    // 픽셀 스캔 결과 검증 (오탐률 보정)
    if (hairTopPx !== null) {
      if (hairTopPx > geminiFaceTopPx + faceBoxHeight * 0.1) {
        console.warn(`[crop] Pixel scan hairTop (${hairTopPx}) is too low (glare detected). Fallbacking.`);
        hairTopPx = null;
      }
      else if (hairTopPx < geminiFaceTopPx - faceBoxHeight * 0.8) {
        console.warn(`[crop] Pixel scan hairTop (${hairTopPx}) is too high (noise/shadow). Fallbacking.`);
        hairTopPx = null;
      }
    }

    const geometricHairTop = Math.max(0, geminiFaceTopPx - faceBoxHeight * 0.25);
    const actualHairTop = hairTopPx ?? geometricHairTop;

    console.log(`[crop] hairTop: pixel=${hairTopPx}, geminiTop=${Math.round(geminiFaceTopPx)}, using=${Math.round(actualHairTop)}`);

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
      console.log(`[crop] Head cropped, retrying with faceRatio=${currentSpec.faceRatio}`);
    }

    if (cropArea!.width < 50 || cropArea!.height < 50) return null;

    // --- 아웃바운드 여백(Padding) 추가 로직 ---
    // 셀카나 여백이 부족한 원본 이미지의 경우 크롭 영역이 이미지 바깥을 벗어날 수 있음.
    // Sharp extract는 바깥을 벗어나면 에러가 나거나 찌그러지므로, 여백을 흰색으로 확장(extend)한다.
    let padTop = 0;
    let padBottom = 0;
    let padLeft = 0;
    let padRight = 0;

    if (cropArea!.top < 0) padTop = Math.abs(cropArea!.top);
    if (cropArea!.left < 0) padLeft = Math.abs(cropArea!.left);
    if (cropArea!.top + cropArea!.height > imgHeight) {
      padBottom = (cropArea!.top + cropArea!.height) - imgHeight;
    }
    if (cropArea!.left + cropArea!.width > imgWidth) {
      padRight = (cropArea!.left + cropArea!.width) - imgWidth;
    }

    // 패딩이 적용되었을 때, 실제 extract 좌표는 0 이상으로 밀려야 함.
    const extractArea = {
      left: cropArea!.left < 0 ? 0 : cropArea!.left + padLeft,
      top: cropArea!.top < 0 ? 0 : cropArea!.top + padTop,
      width: cropArea!.width,
      height: cropArea!.height,
    };

    console.log('[crop] Calculated pads:', { padTop, padLeft, padBottom, padRight });
    console.log('[crop] Extract area assigned:', extractArea);

    const paddedImage = sharp(imageBuffer).rotate().extend({
      top: padTop,
      bottom: padBottom,
      left: padLeft,
      right: padRight,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    });

    // 3) JPEG 압축
    let quality = 92;
    const MIN_QUALITY = 50;
    let fallbackBuffer: Buffer | null = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await paddedImage.clone()
        .extract(extractArea)
        .resize(spec.w, spec.h, { fit: 'fill' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();

      fallbackBuffer = result;
      if (result.byteLength / 1024 <= spec.maxKB) {
        return { image: result.toString('base64'), headCropped };
      }

      quality -= 12;
      if (quality < MIN_QUALITY) break;
    }

    return { image: fallbackBuffer!.toString('base64'), headCropped };

  } catch (err) {
    console.error('[crop] Error:', err);
    return null;
  }
}
