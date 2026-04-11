import fs from 'fs';
import path from 'path';

const docsDir = path.join(import.meta.dirname, '..', 'docs');
const testImagePath = path.join(docsDir, 'test_image.jpg');

async function runTest(iteration) {
  console.log(`\n▶️ [Iteration ${iteration}] 테스트 시작...`);
  const imageBuffer = fs.readFileSync(testImagePath);
  const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
  const formData = new FormData();
  formData.append('file', blob, 'test_image.jpg');
  formData.append('documentType', 'passport');

  const startTime = Date.now();
  const response = await fetch('http://localhost:3000/api/validate', {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`  ⏱️ 응답 시간: ${elapsed}초`);
  console.log(`  📊 HTTP Status: ${response.status}`);
  console.log(`  📋 overall: ${data.overall}`);

  if (data.croppedImage) {
    const croppedBuffer = Buffer.from(data.croppedImage, 'base64');
    const outputPath = path.join(docsDir, `stress_result_${iteration}.jpg`);
    fs.writeFileSync(outputPath, croppedBuffer);
    console.log(`  ✅ 크롭 저장됨: stress_result_${iteration}.jpg`);
    
    // sharp를 사용하여 크기 확인
    const sharp = (await import('sharp')).default;
    const meta = await sharp(croppedBuffer).metadata();
    console.log(`  📐 크기: ${meta.width}x${meta.height}px`);
  } else {
    console.log('  ❌ 크롭 실패!');
    if (data.enhanceFailed) console.log(`     Enhance 실패 사유: ${data.enhanceFailReason}`);
  }
}

async function main() {
  console.log("🚀 [Stress Test] Gemini 2.5 Pro 일관성 하드 테스트 시작 (3회 반복)");
  for (let i = 1; i <= 3; i++) {
    await runTest(i);
    if (i < 3) {
      console.log("   (1초 대기...)");
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log("\n🎉 모든 테스트 완료! docs/ 폴더의 stress_result_ 1~3.jpg를 확인하세요.");
}

main().catch(console.error);
