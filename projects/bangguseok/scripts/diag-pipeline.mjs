/**
 * 풀 파이프라인 진단 스크립트
 * 각 단계의 중간 결과를 모두 저장하여 문제를 정확히 파악
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) throw new Error("GEMINI_API_KEY is not set in .env.local");
const ai = new GoogleGenAI({ apiKey: API_KEY });

const docsDir = path.join(import.meta.dirname, '..', 'docs');

// 프로덕션과 동일한 enhance 프롬프트
const ENHANCE_PROMPT = `이 사진을 아래 지시에 따라 편집하여 보정된 이미지를 반환하세요. 텍스트 설명 없이 편집된 이미지만 출력하세요.

[필수 편집]
1. 배경을 완전한 순백색(#FFFFFF)으로 교체.
2. 얼굴과 상체를 균일하고 밝게 보정.
3. 전체 색감을 맑고 깨끗한 톤으로 보정.

[금지 사항]
- 사진의 구도, 크롭, 줌을 변경하지 마세요. 원본과 동일한 프레이밍을 유지.
- 얼굴 형태, 표정 변경 금지.

반드시 편집된 이미지를 출력하세요.`;

async function main() {
  // 1. EXIF 정규화
  console.log('📸 Step 0: EXIF 정규화...');
  const rawBuffer = fs.readFileSync(path.join(docsDir, 'test_image.jpg'));
  const normalizedBuffer = await sharp(rawBuffer).rotate().toBuffer();
  const normalMeta = await sharp(normalizedBuffer).metadata();
  console.log(`  정규화 후: ${normalMeta.width}x${normalMeta.height}`);

  // 2. Gemini enhance (배경 제거)
  console.log('\n🎨 Step 1: Gemini enhance (배경 제거)...');
  const enhanceResponse = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: [{ role: 'user', parts: [
      { text: ENHANCE_PROMPT },
      { inlineData: { mimeType: 'image/jpeg', data: normalizedBuffer.toString('base64') } },
    ]}],
    config: { responseModalities: ['IMAGE', 'TEXT'] },
  });

  let enhancedBuffer = null;
  const parts = enhanceResponse.candidates?.[0]?.content?.parts;
  for (const part of parts) {
    if (part.inlineData?.data) {
      enhancedBuffer = Buffer.from(part.inlineData.data, 'base64');
    }
  }

  if (!enhancedBuffer) {
    console.error('❌ Enhance 실패!');
    return;
  }

  const enhancedMeta = await sharp(enhancedBuffer).metadata();
  console.log(`  ✅ Enhanced: ${enhancedMeta.width}x${enhancedMeta.height}`);
  console.log(`  🔍 크기 변화: ${normalMeta.width}x${normalMeta.height} → ${enhancedMeta.width}x${enhancedMeta.height}`);
  
  if (normalMeta.width !== enhancedMeta.width || normalMeta.height !== enhancedMeta.height) {
    console.log(`  🔴 크기 변경됨! 비율: ${(enhancedMeta.width / normalMeta.width).toFixed(3)}x${(enhancedMeta.height / normalMeta.height).toFixed(3)}`);
  } else {
    console.log('  ✅ 크기 동일');
  }

  fs.writeFileSync(path.join(docsDir, 'diag_1_enhanced.jpg'), enhancedBuffer);

  // 3. 픽셀 스캔으로 머리끝 감지
  console.log('\n🔬 Step 2: 픽셀 스캔 (머리끝 감지)...');
  const { data, info } = await sharp(enhancedBuffer).raw().toBuffer({ resolveWithObject: true });
  
  const centerX = 0.5; // 대략적 중심
  const scanLeft = Math.max(0, Math.floor((centerX - 0.20) * info.width));
  const scanRight = Math.min(info.width, Math.ceil((centerX + 0.20) * info.width));
  const scanWidth = scanRight - scanLeft;

  let hairTopPx = null;
  for (let y = 0; y < Math.floor(info.height * 0.6); y++) {
    let nonWhiteCount = 0;
    for (let x = scanLeft; x < scanRight; x++) {
      const idx = (y * info.width + x) * info.channels;
      if (data[idx] < 240 || data[idx + 1] < 240 || data[idx + 2] < 240) {
        nonWhiteCount++;
      }
    }
    if (nonWhiteCount / scanWidth > 0.02) {
      hairTopPx = y;
      break;
    }
  }

  console.log(`  hairTopPx = ${hairTopPx}px (${(hairTopPx / info.height * 100).toFixed(1)}%)`);

  // 4. 크롭 수학 시뮬레이션
  const faceCm = 3.0;
  const heightCm = 4.5;
  const topMarginCm = 0.4;
  const CHIN_SHRINK = 0.85;
  const chinRatio = 0.529; // Gemini typical chin value

  const imgW = enhancedMeta.width;
  const imgH = enhancedMeta.height;
  const rawChinPx = chinRatio * imgH;
  const grossFace = rawChinPx - hairTopPx;
  const correctedFace = grossFace * CHIN_SHRINK;
  const correctedChinPx = hairTopPx + correctedFace;
  
  const faceRatio = faceCm / heightCm;
  const cropHeight = correctedFace / faceRatio;
  const cropWidth = cropHeight * (413 / 531);
  const topMarginPx = cropHeight * (topMarginCm / heightCm);
  const cropTop = hairTopPx - topMarginPx;
  const cropBottom = cropTop + cropHeight;

  console.log('\n' + '='.repeat(60));
  console.log('📐 크롭 시뮬레이션');
  console.log('='.repeat(60));
  console.log(`  rawChinPx      = ${rawChinPx.toFixed(0)}px`);
  console.log(`  grossFaceH     = ${grossFace.toFixed(0)}px`);
  console.log(`  correctedFaceH = ${correctedFace.toFixed(0)}px (×${CHIN_SHRINK})`);
  console.log(`  correctedChinPx= ${correctedChinPx.toFixed(0)}px`);
  console.log(`  faceRatio      = ${faceRatio.toFixed(3)} (${faceCm}/${heightCm})`);
  console.log(`  cropHeight     = ${cropHeight.toFixed(0)}px`);
  console.log(`  cropWidth      = ${cropWidth.toFixed(0)}px`);
  console.log(`  topMarginPx    = ${topMarginPx.toFixed(0)}px`);
  console.log(`  cropTop        = ${cropTop.toFixed(0)}px`);
  console.log(`  cropBottom     = ${cropBottom.toFixed(0)}px`);
  console.log(`  shoulderArea   = ${(cropBottom - correctedChinPx).toFixed(0)}px (${((cropBottom - correctedChinPx) / cropHeight * 100).toFixed(1)}%)`);
  
  if (cropTop < 0) console.log(`  🔴 cropTop < 0: ${Math.abs(cropTop).toFixed(0)}px 패딩 필요`);
  if (cropBottom > imgH) console.log(`  🔴 cropBottom > imgH: ${(cropBottom - imgH).toFixed(0)}px 패딩 필요`);

  // 5. 시각화
  console.log('\n🎨 시각화 생성...');
  const drawCT = Math.max(0, Math.round(cropTop));
  const drawCL = Math.max(0, Math.round((centerX * imgW) - cropWidth / 2));
  const drawCB = Math.min(imgH, Math.round(cropBottom));
  const drawCR = Math.min(imgW, Math.round((centerX * imgW) + cropWidth / 2));

  const svgOverlay = `
    <svg width="${imgW}" height="${imgH}">
      <rect x="${drawCL}" y="${drawCT}" width="${drawCR - drawCL}" height="${drawCB - drawCT}" 
            fill="none" stroke="yellow" stroke-width="4" stroke-dasharray="15,10"/>
      <line x1="0" y1="${hairTopPx}" x2="${imgW}" y2="${hairTopPx}" stroke="#00AAFF" stroke-width="3"/>
      <text x="10" y="${hairTopPx - 10}" fill="#00AAFF" font-size="28" font-weight="bold">HAIR TOP y=${hairTopPx}px (pixel scan)</text>
      <line x1="0" y1="${Math.round(correctedChinPx)}" x2="${imgW}" y2="${Math.round(correctedChinPx)}" stroke="#FF3333" stroke-width="3"/>
      <text x="10" y="${Math.round(correctedChinPx) + 30}" fill="#FF3333" font-size="28" font-weight="bold">CORRECTED CHIN y=${Math.round(correctedChinPx)}px</text>
      <line x1="0" y1="${Math.round(rawChinPx)}" x2="${imgW}" y2="${Math.round(rawChinPx)}" stroke="#FF9999" stroke-width="2" stroke-dasharray="10,5"/>
      <text x="10" y="${Math.round(rawChinPx) + 25}" fill="#FF9999" font-size="20">RAW CHIN y=${Math.round(rawChinPx)}px (Gemini)</text>
    </svg>
  `;

  const vizBuffer = await sharp(enhancedBuffer)
    .composite([{ input: Buffer.from(svgOverlay), blend: 'over' }])
    .jpeg({ quality: 95 })
    .toBuffer();

  fs.writeFileSync(path.join(docsDir, 'diag_2_coords.jpg'), vizBuffer);
  console.log('✅ 저장됨: docs/diag_1_enhanced.jpg, docs/diag_2_coords.jpg');
}

main().catch(console.error);
