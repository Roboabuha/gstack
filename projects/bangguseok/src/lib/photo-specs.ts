/**
 * 증명사진 규격 상수 — 3종 문서 타입
 *
 * 규격 출처:
 *   여권: 외교부 여권 사진 규격 (ICAO 표준, 3.5×4.5cm → 413×531px @300dpi)
 *   주민등록증/운전면허: 3.5×4.5cm 동일 규격
 *   이력서/학생증: 반명함 3×4cm → 354×472px @300dpi
 */

export type DocumentType = 'passport' | 'id_card' | 'resume';

export interface PhotoSpec {
  /** 출력 너비 (px) */
  w: number;
  /** 출력 높이 (px) */
  h: number;
  /** 물리적 높이 (cm) */
  heightCm: number;
  /** 최대 파일 크기 (KB) */
  maxKB: number;
  /** 한국어 라벨 */
  label: string;
  /** 목표 얼굴 길이 (머리끝~턱, cm) */
  faceCm: number;
  /** 목표 정수리 여백 (이미지 상단~머리끝, cm) */
  topMarginCm: number;
}

export const PHOTO_SPECS: Record<DocumentType, PhotoSpec> = {
  passport: {
    w: 413,
    h: 531,
    heightCm: 4.5,
    maxKB: 500,
    label: '여권',
    faceCm: 3.6,       // 규격: 정수리~턱 최댓값 (3.2~3.6cm)
                        // 샘플 사진들보다 얼굴을 조금 더 강조
    topMarginCm: 0.3,  // 샘플 사진들과 동일한 정수리 여백
  },
  id_card: {
    w: 413,
    h: 531,
    heightCm: 4.5,
    maxKB: 500,
    label: '주민등록증/운전면허',
    faceCm: 3.6,
    topMarginCm: 0.3,
  },
  resume: {
    w: 354,
    h: 472,
    heightCm: 4.0,
    maxKB: 500,
    label: '이력서/학생증',
    faceCm: 3.0,       // 3x4 사진: 약간 작게
    topMarginCm: 0.3,
  },
} as const;

export const DOCUMENT_TYPES = Object.keys(PHOTO_SPECS) as DocumentType[];

export function isValidDocumentType(value: string): value is DocumentType {
  return DOCUMENT_TYPES.includes(value as DocumentType);
}
