/**
 * E2E 테스트 v2: 중간 결과(enhanced 이미지) 포함 저장
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(__dirname, '..', 'docs');
const testImagePath = path.join(docsDir, 'test_image.jpg');

if (!fs.existsSync(testImagePath)) {
  console.error('❌ docs/test_image.jpg 없음!');
  process.exit(1);
}

const imageBuffer = fs.readFileSync(testImagePath);
const blob = new Blob([imageBuffer], { type: 'image/jpeg' });

const formData = new FormData();
formData.append('file', blob, 'test_image.jpg');
formData.append('documentType', 'passport');

console.log('🚀 POST /api/validate 호출 중...');
console.log(`  파일: test_image.jpg (${(imageBuffer.length / 1024).toFixed(0)} KB)`);

const startTime = Date.now();

try {
  const response = await fetch('http://localhost:3000/api/validate', {
    method: 'POST',
    body: formData,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n⏱️  응답 시간: ${elapsed}초`);
  console.log(`📊 HTTP Status: ${response.status}`);

  const data = await response.json();

  // 검증 결과 출력
  console.log('\n' + '='.repeat(60));
  console.log('📋 검증 결과');
  console.log('='.repeat(60));
  console.log(`  overall: ${data.overall}`);
  console.log(`  feasible: ${data.feasible}`);

  if (data.rejectionReason) {
    console.log(`  ❌ rejectionReason: ${data.rejectionReason}`);
  }

  if (data.checks) {
    for (const [key, check] of Object.entries(data.checks)) {
      const c = check;
      const icon = c.result === 'PASS' ? '✅' : '❌';
      console.log(`  ${icon} ${key}: ${c.result} — ${c.reason}`);
    }
  }

  // 크롭 결과 저장
  if (data.croppedImage) {
    const croppedBuffer = Buffer.from(data.croppedImage, 'base64');
    const outputPath = path.join(docsDir, 'e2e_result.jpg');
    fs.writeFileSync(outputPath, croppedBuffer);
    console.log(`\n✅ 크롭 결과 저장됨: ${outputPath} (${(croppedBuffer.length / 1024).toFixed(0)} KB)`);
    
    // sharp로 크롭 결과 치수 확인
    const sharp = (await import('sharp')).default;
    const meta = await sharp(croppedBuffer).metadata();
    console.log(`  크롭 이미지 크기: ${meta.width}x${meta.height}px`);
  } else {
    console.log('\n⚠️  croppedImage 없음');
    if (data.cropFailed) console.log('  → cropFailed: true');
    if (data.enhanceFailed) console.log(`  → enhanceFailed: ${data.enhanceFailReason}`);
  }
} catch (err) {
  console.error('❌ API 호출 실패:', err.message);
}
