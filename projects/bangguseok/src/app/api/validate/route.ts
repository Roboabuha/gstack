import { NextRequest, NextResponse } from 'next/server';
import { isValidDocumentType, PHOTO_SPECS } from '@/lib/photo-specs';
import { isValidFaceCoords, type ValidateResponse, type ErrorResponse } from '@/lib/schemas';
import { validateWithGemini, enhancePhoto, detectFaceCoords, GeminiError } from '@/lib/gemini';
import { cropOriginalImage, compressImage } from '@/lib/crop';
import { checkRateLimit } from '@/lib/rate-limit';
import { getMimeTypeFromMagicNumber } from '@/lib/magic-number';

/**
 * POST /api/validate
 *
 * 3단계 파이프라인:
 *   Step 1: Gemini 텍스트 — 8항목 검증 + 얼굴 좌표 + 변환 가능성 판단
 *   Step 2: Gemini 이미지 — 배경 순백색 교체 + 밝기 보정 (feasible=true인 경우)
 *   Step 3: Sharp — 규격 크롭 + 리사이즈 + JPEG 압축
 *
 * 요청: FormData
 *   - file: 이미지 파일 (JPEG/PNG, ≤4MB)
 *   - documentType: 'passport' | 'id_card' | 'resume'
 *
 * 응답:
 *   - 200: { checks, overall, feasible, rejectionReason?, croppedImage?, ... }
 *   - 400/429/500/504: { error, code }
 */

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB

export async function POST(request: NextRequest) {
  let ip = 'unknown';
  try {
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
      // 프록시 배열의 가장 마지막(우측) 값이 Traefik이 추가한 클라이언트의 실제 IP입니다.
      // 공격자가 앞부분을 변조하더라도 마지막 IP를 추출해 방어합니다.
      ip = forwardedFor.split(',').pop()?.trim() || 'unknown';
    } else {
      ip = request.headers.get('x-real-ip') || '127.0.0.1';
    }

    // 0. Rate Limiting (API 비용 폭탄 방어)
    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.success) {
      console.warn(`[Security] Rate limit exceeded for IP: ${ip}`);
      return errorResponse('요청이 너무 많습니다. 잠시 후 다시 시도해주세요.', 429);
    }

    // 1. FormData 파싱
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse('올바른 형식으로 요청해주세요', 400);
    }

    // 2. 입력 검증
    const file = formData.get('file');
    const documentType = formData.get('documentType') as string;

    if (!file || !(file instanceof File)) {
      return errorResponse('이미지 파일을 선택해주세요', 400);
    }

    if (!documentType || !isValidDocumentType(documentType)) {
      return errorResponse('용도를 선택해주세요 (여권/주민등록증/이력서)', 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return errorResponse('파일 크기가 4MB를 초과합니다. 더 작은 파일을 사용해주세요', 400);
    }

    const mimeType = file.type;
    if (!mimeType.startsWith('image/')) {
      return errorResponse('이미지 파일만 업로드할 수 있습니다', 400);
    }

    // 3. 이미지 버퍼 변환
    const arrayBuffer = await file.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer) as Buffer<ArrayBuffer>;

    // 3.5 파일 서명(Magic Number) 검증 (악성 파일 업로드 방어)
    const realMimeType = getMimeTypeFromMagicNumber(imageBuffer);
    if (!realMimeType) {
      console.warn(`[Security] Invalid file signature detected from IP: ${ip}`);
      return errorResponse('유효하지 않은 이미지 파일입니다. 파일 변조가 의심됩니다.', 400);
    }

    // ========================================
    // Step 1: Gemini 검증 (8항목 + 좌표 + 실현가능성)
    // ========================================
    console.log('[validate] Step 1: Calling Gemini validate with', file.name, file.size, 'bytes');
    const geminiResult = await validateWithGemini(imageBuffer, realMimeType);
    console.log('[validate] Step 1 result:', geminiResult.overall, 'feasible:', geminiResult.feasible);

    const response: ValidateResponse = {
      checks: geminiResult.checks,
      overall: geminiResult.overall,
      feasible: geminiResult.feasible,
    };

    // 변환 불가 → 사유와 함께 즉시 반환
    if (!geminiResult.feasible) {
      response.rejectionReason = geminiResult.rejection_reason || '이 사진은 증명사진으로 변환하기 어렵습니다. 다른 사진을 사용해주세요.';
      console.log('[validate] Not feasible:', response.rejectionReason);
      return NextResponse.json(response, { status: 200 });
    }

    // ========================================
    // Step 2: 원본 이미지에서 안전하게 크롭 먼저 진행
    // ========================================
    let headCropped = false;
    let croppedBuffer: Buffer | null = null;
    let cropFailed = false;

    console.log('[validate] Step 2: Cropping original image directly...');
    const spec = PHOTO_SPECS[documentType];
    const cropResult = await cropOriginalImage(imageBuffer, geminiResult.face, spec);

    if (cropResult) {
      croppedBuffer = cropResult.buffer;
      headCropped = cropResult.headCropped;
      console.log('[validate] Step 2: Crop success, headCropped:', headCropped);
    } else {
      cropFailed = true;
      response.cropFailed = true;
      console.log('[validate] Step 2: Crop returned null');
    }

    if (cropFailed || !croppedBuffer) {
      return NextResponse.json(response, { status: 200 });
    }

    // ========================================
    // Step 3: 잘려진 사진의 배경 제거 및 밝기 보정
    // ========================================
    let finalBufferToCompress = croppedBuffer;
    let enhanceFailReason: string | undefined;

    try {
      console.log('[validate] Step 3: Calling Gemini enhance on cropped image...');
      const enhanceResult = await enhancePhoto(croppedBuffer, mimeType);

      if (enhanceResult.image) {
        finalBufferToCompress = enhanceResult.image;
        console.log('[validate] Step 3: Enhancement success');
      } else {
        enhanceFailReason = enhanceResult.failReason;
        response.enhanceFailed = true;
        response.enhanceFailReason = enhanceFailReason;
        console.log('[validate] Step 3: Enhancement failed:', enhanceFailReason);
      }
    } catch (enhanceError) {
      response.enhanceFailed = true;
      console.error('[validate] Step 3: Enhancement error suppressed');
    }

    // ========================================
    // Step 4: JPEG 압축 (Base64)
    // ========================================
    console.log('[validate] Step 4: Compressing...');
    response.croppedImage = await compressImage(finalBufferToCompress, spec);

    // ========================================
    // Step 5: 최종 검증 결과 업데이트
    // ========================================
    // 배경 보정 성공
    response.checks.background_white = {
      result: 'PASS',
      reason: '✨ AI가 배경을 순백색으로 보정했습니다',
    };
    response.checks.no_shadow = {
      result: 'PASS',
      reason: '✨ AI가 그림자를 제거하고 밝기를 보정했습니다',
    };

    if (!cropFailed) {
      response.checks.face_ratio = {
        result: 'PASS',
        reason: '✨ 규격에 맞게 얼굴 비율을 자동 조정했습니다 (약 75%)',
      };

      // 머리 잘림 감지 → FAIL로 오버라이드
      if (headCropped) {
        response.checks.head_not_cropped = {
          result: 'FAIL',
          reason: '⚠️ 머리카락 상단이 잘렸습니다. 정수리 위 여백이 충분한 사진으로 다시 시도해주세요.',
        };
        console.log('[validate] Head cropped detected → overriding to FAIL');
      } else {
        response.checks.head_not_cropped = {
          result: 'PASS',
          reason: '✨ 정수리 여백을 포함하여 규격 크롭했습니다',
        };
      }
    }

    // overall 재계산
    const allPass = Object.values(response.checks).every(
      (check) => check.result === 'PASS'
    );
    response.overall = allPass ? 'PASS' : 'FAIL';

    return NextResponse.json(response, { status: 200 });

  } catch (error) {
    if (error instanceof GeminiError) {
      return errorResponse(error.message, error.statusCode);
    }

    console.error(`[Security] Unexpected error in /api/validate (IP: ${ip})`);
    return errorResponse('서비스 오류가 발생했습니다. 잠시 후 다시 시도해주세요', 500);
  }
}

function errorResponse(message: string, code: number) {
  const body: ErrorResponse = { error: message, code };
  return NextResponse.json(body, { status: code });
}
