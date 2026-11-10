const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
 const page=await browser.newPage({baseURL:process.env.TEST_URL,viewport:{width:1600,height:1050}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.goto('/');await page.locator('#welcome-business').selectOption('raon');await page.locator('#welcome-form button').click();
 const unauthorized=await page.request.put('/api/admin/interface-copy',{data:{revision:0,scope:'all',texts:{}}});assert.equal(unauthorized.status(),401);
 await page.locator('[data-view=admin]').click();await page.locator('#admin-login-form input').fill('test-only-code');await page.locator('#admin-login-form button').click();
 await page.locator('[data-admin-tab=copy]').waitFor();
 await page.locator('.theme-toggle').click();
 assert.equal(await page.locator('body').getAttribute('data-admin-theme'),'light');
 assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).getPropertyValue('--ink').trim()),'#202124');
 await page.locator('[data-admin-tab=copy]').click();
 const frame=page.frameLocator('#copy-frame');
 await frame.locator('.workspace-hero h2').click();
 await page.waitForFunction(()=>document.querySelector('#copy-key').value==='{business}의 하루를 한눈에.');
 await page.locator('#copy-value').fill('{business} 오늘의 업무');await page.locator('#copy-apply').click();
 await frame.locator('.workspace-hero h2').filter({hasText:'공동작업장 라온 오늘의 업무'}).waitFor();
 await page.locator('#copy-save').click();await page.getByText('저장했습니다. 새로고침 후에도 유지됩니다.',{exact:true}).waitFor();
 await page.locator('#copy-scope').selectOption('raon');
 await frame.locator('.workspace-hero > div > p').last().click();await page.waitForFunction(()=>document.querySelector('#copy-key').value==='거래를 기록하고, 필요한 재고를 확인하세요.');await page.locator('#copy-value').fill('라온 전용 안내');await page.locator('#copy-apply').click();await page.locator('#copy-save').click();
 await page.getByText('저장했습니다. 새로고침 후에도 유지됩니다.',{exact:true}).waitFor();
 // Read-only preview blocks mutations even if the input form is opened.
 const blocked=await page.locator('#copy-frame').evaluate(async el=>{try{await el.contentWindow.api('/api/items',{method:'POST',body:'{}'});return false;}catch(e){return e.message.includes('미리보기');}});assert.equal(blocked,true);
 const saved=await (await page.request.get('/api/interface-copy')).json();
 assert.equal(saved.scopes.all['{business}의 하루를 한눈에.'],'{business} 오늘의 업무');
 assert.equal(saved.scopes.raon['거래를 기록하고, 필요한 재고를 확인하세요.'],'라온 전용 안내');
 assert.equal((await page.request.put('/api/admin/interface-copy',{data:{revision:0,scope:'all',texts:{}}})).status(),409);
 assert.equal((await page.request.put('/api/admin/interface-copy',{data:{revision:saved.revision,scope:'all',texts:{'{business}의 하루를 한눈에.':'잘못된 문구'}}})).status(),400);
 await page.locator('[data-view=dashboard]').first().click();
 await page.locator('.workspace-hero p').filter({hasText:'라온 전용 안내'}).waitFor();
 await page.locator('#business-switcher').selectOption('cafe');
 await page.locator('.workspace-hero h2').filter({hasText:'카페온리 오늘의 업무'}).waitFor();
 assert.equal(await page.locator('.workspace-hero').innerText().then(t=>t.includes('라온 전용 안내')),false);
 await page.reload();await page.locator('.workspace-hero h2').filter({hasText:'카페온리 오늘의 업무'}).waitFor();
 assert.equal(await page.locator('body').getAttribute('data-admin-theme'),'light');
 await page.locator('[data-view=admin]').click();await page.locator('#admin-login-form input').fill('test-only-code');await page.locator('#admin-login-form button').click();await page.locator('[data-admin-tab=copy]').click();
 await page.locator('.theme-toggle').click();assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).getPropertyValue('--ink').trim()),'#f3f3f3');
 await page.locator('#copy-scope').selectOption('raon');await frame.locator('.workspace-hero p').filter({hasText:'라온 전용 안내'}).click();await page.waitForFunction(()=>document.querySelector('#copy-key').value==='거래를 기록하고, 필요한 재고를 확인하세요.');await page.locator('#copy-reset').click();
 await frame.locator('.workspace-hero p').filter({hasText:'거래를 기록하고, 필요한 재고를 확인하세요.'}).waitFor();
 await page.locator('#copy-save').click();await page.getByText('저장했습니다. 새로고침 후에도 유지됩니다.',{exact:true}).waitFor();
 if(process.env.SCREENSHOT_DIR){await page.screenshot({path:process.env.SCREENSHOT_DIR+'/copy-dark.png'});await page.locator('.theme-toggle').click();await page.screenshot({path:process.env.SCREENSHOT_DIR+'/copy-light.png'});}
 assert.deepEqual(errors,[]);console.log('PASS: themes, full home preview, global/business copy, persistence, reset, auth, revision conflict, placeholders, read-only preview');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
