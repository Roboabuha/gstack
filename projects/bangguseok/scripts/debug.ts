import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// We need to simulate the exact pipeline steps:
// 1. Load image
// 2. enhancePhoto
// 3. detectFaceCoords
// 4. detectHairTopByPixel
// 5. cropAndResize

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) throw new Error("GEMINI_API_KEY is not set in .env.local");
const ai = new GoogleGenAI({ apiKey: API_KEY });

const ENHANCE_PROMPT = `이 사진을 아래 지시에 따라 편집하여 보정된 이미지를 반환하세요. 텍스트 설명 없이 편집된 이미지만 출력하세요.

[필수 편집]
1. 배경을 완전한 순백색(#FFFFFF)으로 교체. 벽지, 그림자, 무늬, 기타 배경 요소 모두 제거.
2. 얼굴과 상체를 균일하고 밝게 보정. 어두운 그림자 자연스럽게 제거.
3. 전체 색감을 맑고 깨끗한 톤으로 보정.

[리터칭 — 적응적으로]
4. 피부의 잡티, 여드름, 다크서클을 자연스럽게 축소. 피부결 유지.
5. 사진이 어두우면 밝기를 높이고, 이미 밝으면 유지.
6. 피부톤을 자연스러운 화사한 웜톤으로 미세 조정.
7. 눈, 눈썹, 머리카락 디테일을 살짝 선명하게.
8. 얼굴의 입체감을 위해 대비를 미세하게 조정.

[금지 사항]
- 사진의 구도, 크롭, 줌을 변경하지 마세요. 원본과 동일한 프레이밍을 유지.
- 얼굴 형태, 표정, 옷, 액세서리, 머리카락 스타일 변경 금지.
- 과도한 에어브러시 금지. 자연스러운 피부결 유지.
- 인물 윤곽선과 머리카락 경계를 자연스럽게 유지.

반드시 편집된 이미지를 출력하세요.`;

const FACE_DETECT_PROMPT = `이 사진에서 인물의 얼굴 위치를 0.0~1.0 범위의 상대 좌표로 반환하세요.
(0,0)은 이미지 좌상단, (1,1)은 우하단입니다. 텍스트 설명 없이 JSON만 반환하세요.

- top: 머리 꼭대기(머리카락 포함)의 y좌표
- chin: 턱 끝의 y좌표
- centerX: 얼굴 중심의 x좌표
- centerY: 얼굴 중심의 y좌표`;

const FACE_DETECT_SCHEMA = {
  type: 'object' as const,
  properties: {
    top: { type: 'number' as const },
    chin: { type: 'number' as const },
    centerX: { type: 'number' as const },
    centerY: { type: 'number' as const },
  },
  required: ['top', 'chin', 'centerX', 'centerY'],
};

async function main() {
  const inputDir = path.join(__dirname, '..', 'docs');
  const inputFile = path.join(inputDir, 'test_image.jpg');
  console.log('Loading:', inputFile);
  const originalBuffer = fs.readFileSync(inputFile);
  
  const originalMeta = await sharp(originalBuffer).metadata();
  console.log(`[ORIGINAL] size: ${originalMeta.width}x${originalMeta.height}`);

  console.log('\n--- STEP 1: ENHANCE PHOTO ---');
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: [
      {
        role: 'user',
        parts: [
          { text: ENHANCE_PROMPT },
          { inlineData: { mimeType: 'image/jpeg', data: originalBuffer.toString('base64') } },
        ],
      },
    ],
    config: { responseModalities: ['IMAGE', 'TEXT'] },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  let enhancedBuffer: Buffer | null = null;
  for (const part of parts!) {
    if (part.inlineData?.data) {
      enhancedBuffer = Buffer.from(part.inlineData.data, 'base64');
    }
  }

  if (!enhancedBuffer) {
    console.error("Enhance failed!"); return;
  }

  fs.writeFileSync(path.join(inputDir, 'debug_1_enhanced.jpg'), enhancedBuffer);
  const enhancedMeta = await sharp(enhancedBuffer).metadata();
  console.log(`[ENHANCED] size: ${enhancedMeta.width}x${enhancedMeta.height}`);
  console.log(`[ANALYSIS] Dimensions changed? Width: ${originalMeta.width}->${enhancedMeta.width}, Height: ${originalMeta.height}->${enhancedMeta.height}`);

  console.log('\n--- STEP 2: DETECT FACE ---');
  const response2 = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: FACE_DETECT_PROMPT },
          { inlineData: { mimeType: 'image/jpeg', data: enhancedBuffer.toString('base64') } },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', responseSchema: FACE_DETECT_SCHEMA },
  });
  const faceDataStr = response2.candidates?.[0]?.content?.parts?.[0]?.text;
  const faceCoords = JSON.parse(faceDataStr!);
  console.log(`[COORDS] ${JSON.stringify(faceCoords)}`);

  console.log('\n--- STEP 3: PIXEL SCAN ---');
  const { data, info } = await sharp(enhancedBuffer).rotate().raw().toBuffer({ resolveWithObject: true });
  let hairTopPx: number | null = null;
  for (let y = 0; y < Math.floor(info.height * 0.6); y++) {
    let nonWhiteCount = 0;
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels;
      if (data[idx] < 240 || data[idx + 1] < 240 || data[idx + 2] < 240) nonWhiteCount++;
    }
    if (nonWhiteCount / info.width > 0.03) {
      hairTopPx = y; break;
    }
  }
  console.log(`[PIXEL SCAN] hairTopPx = ${hairTopPx}`);

  // Create an SVG overlay to visualize
  const svgOverlay = `
    <svg width="${enhancedMeta.width}" height="${enhancedMeta.height}">
      <circle cx="${faceCoords.centerX * enhancedMeta.width}" cy="${faceCoords.chin * enhancedMeta.height}" r="10" fill="red"/>
      <circle cx="${faceCoords.centerX * enhancedMeta.width}" cy="${faceCoords.top * enhancedMeta.height}" r="10" fill="blue"/>
      <line x1="0" y1="${hairTopPx}" x2="${enhancedMeta.width}" y2="${hairTopPx}" stroke="green" stroke-width="5"/>
      <text x="10" y="${hairTopPx! - 10}" fill="green" font-size="20">Pixel Scan Hair Top</text>
      <text x="${faceCoords.centerX * enhancedMeta.width + 15}" y="${faceCoords.chin * enhancedMeta.height}" fill="red" font-size="20">Gemini Chin</text>
    </svg>
  `;
  const highlightedBuffer = await sharp(enhancedBuffer)
    .composite([{ input: Buffer.from(svgOverlay), blend: 'over' }])
    .toBuffer();
  fs.writeFileSync(path.join(inputDir, 'debug_2_highlighted.jpg'), highlightedBuffer);
  
  console.log('\n✅ Debug images generated in /docs:');
  console.log('1. debug_1_enhanced.jpg');
  console.log('2. debug_2_highlighted.jpg');
  console.log('\nPlease check the highlighted image to see if Gemini distorted the original aspect ratio or completely misidentified the chin!');
}

main().catch(console.error);
