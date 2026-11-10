/* Interface copy is text-only. Business records and entered values are never rewritten. */
const interfaceCopy = (() => {
  const preview = window.parent !== window ? new URLSearchParams(location.search).get('copy-preview') : null;
  let settings = {revision:0,scopes:{}}, draft = null, selecting = true;
  const records = new WeakMap();
  let entries = [], scheduled = false;
  const pageTitle = document.title;
  const excluded = 'script,style,textarea,code,pre,[contenteditable],.copy-editor,#notice-title,#notice-message,#welcome-title,#welcome-message,#welcome-error,#today-label,.stock-row,.stock-sub,.kpi .value,.ledger-summary strong';
  function scopeTexts() {
    if (draft) return draft;
    return {...settings.scopes.all,...settings.scopes[state.businessId]};
  }
  function allowed(el, templatePreview) {
    if (!el || el.closest(excluded)) return false;
    if (!templatePreview && document.body.dataset.admin==='true') return false;
    if (el.closest('option') && (!el.hasAttribute('value') || /^\d+$/.test(el.value) || el.closest('#business-switcher,#welcome-business'))) return false;
    if (el.closest('tbody') && !el.closest('button')) return false;
    return true;
  }
  function apply(root = document.body, businessId = state.businessId) {
    const templatePreview = root !== document.body;
    if (!templatePreview) scheduled = false;
    const texts = templatePreview ? {...settings.scopes.all, ...settings.scopes[businessId]} : scopeTexts();
    if (templatePreview && !Object.keys(texts).length) return;
    const next = [];
    if(!templatePreview && document.body.dataset.admin!=='true')document.title=texts[pageTitle]??pageTitle;
    next.push({el:document.querySelector('.brand'),key:pageTitle,value:texts[pageTitle]??pageTitle});
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, el = node.parentElement;
      if (!allowed(el, templatePreview)) continue;
      let record = records.get(node);
      if (!record || node.nodeValue !== record.rendered) {
        const raw = node.nodeValue, original = raw.trim();
        const template = el.dataset.copyTemplate;
        if (!template && (!/[가-힣a-zA-Z]/.test(original) || /\d/.test(original) || original.length>500)) continue;
        if (!template && [...state.businesses,...state.items,...state.partners].some(x=>x.name===original)) continue;
        record = {key:template||original, raw, rendered:raw};
        records.set(node,record);
      }
      let value = texts[record.key] ?? record.key;
      const vars = JSON.parse(el.dataset.copyVars||'{}');
      value = value.replace(/\{([a-zA-Z_]+)\}/g, (match,key)=>vars[key]??match);
      const rendered = record.raw.replace(record.raw.trim(),value);
      if (node.nodeValue!==rendered) node.nodeValue=rendered;
      record.rendered=rendered;
      next.push({el,key:record.key,value:texts[record.key]??record.key});
    }
    // Placeholder and accessible descriptions use attributes, never input values.
    for (const el of root.querySelectorAll('[placeholder],[aria-label],[title]')) {
      if (!allowed(el, templatePreview)) continue;
      let map = records.get(el); if(!map){map={};records.set(el,map);}
      for(const attr of ['placeholder','aria-label','title']) {
        if(!el.hasAttribute(attr)) continue;
        let rec=map[attr], current=el.getAttribute(attr);
        if(!rec||rec.rendered!==current) rec=map[attr]={key:current,rendered:current};
        if(!rec.key || rec.key.length>500) continue;
        const value=texts[rec.key]??rec.key;
        if(current!==value) el.setAttribute(attr,value);
        rec.rendered=value; next.push({el,key:rec.key,value});
      }
    }
    if (templatePreview) return;
    entries=next;
    if(preview) parent.postMessage({type:'copy-list',entries:[...new Map(next.map(x=>[x.key,{key:x.key,value:x.value}])).values()]},location.origin);
  }
  function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(()=>apply());}}
  async function load(){settings=await api('/api/interface-copy');schedule();}
  function editor(target) {
    target.className='copy-editor';
    target.innerHTML=`<div class="card"><div class="card-head"><div><h2>실제 화면 문구 편집</h2><small>미리보기 글씨를 클릭해 수정하세요. 메뉴·제목·버튼·설명에 적용하며 품목명과 거래 자료는 원래 관리 화면에서 수정합니다.</small></div></div>
      <div class="card-body copy-controls">
        <label>적용 범위 <select id="copy-scope"><option value="all">전체 사업단 공통</option>${state.businesses.map(b=>`<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')}</select></label>
        <label>미리볼 사업단 <select id="copy-business">${state.businesses.map(b=>`<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')}</select></label>
        <label>화면 <select id="copy-page"><option value="dashboard">홈</option><option value="ledger">거래 장부</option><option value="counts">재고 실사</option><option value="work">작업일지</option><option value="cafe">카페 레시피</option><option value="planning">발주·생산능력</option><option value="daily">일일 운영일지</option><option value="monthly">월간 거래요약</option><option value="calendar">달력 대장</option><option value="items">품목 관리</option><option value="partners">기관·거래처</option><option value="import">엑셀 가져오기</option></select></label>
        <label><input id="copy-pick" type="checkbox" checked> 글씨 선택 모드</label><button class="button primary" id="copy-save">문구 저장</button>
        <span id="copy-status" role="status">저장 전 변경은 미리보기에만 반영됩니다.</span>
      </div></div>
      <div class="copy-layout"><div class="card copy-tools"><div class="card-body">
        <div class="field"><label>기본 문구</label><textarea id="copy-key" readonly rows="3"></textarea></div>
        <div class="field"><label>표시할 문구</label><textarea id="copy-value" rows="4" maxlength="2000"></textarea></div>
        <p class="copy-help">{business}, {count}는 자동으로 채워집니다. 같은 기본 문구는 같은 적용 범위에서 함께 변경됩니다. 화면 이동·입력창 열기는 선택 모드를 끄세요. 미리보기에서는 자료를 저장할 수 없습니다.</p>
        <div class="form-actions"><button id="copy-apply" class="button primary">미리보기 반영</button><button id="copy-reset" class="button ghost">이 문구 복원</button></div>
        <div class="field"><label>현재 화면 문구 검색</label><input id="copy-search" type="search"></div><div id="copy-list"></div>
      </div></div><iframe title="실제 화면 문구 편집 미리보기" id="copy-frame"></iframe></div>`;
    const find=s=>target.querySelector(s), frame=find('#copy-frame');
    let data=null, edits={}, dirty=false, list=[], selected='';
    find('#copy-business').value=state.businessId;
    const status=message=>find('#copy-status').textContent=message;
    function merged(){const scope=find('#copy-scope').value,business=find('#copy-business').value;return scope==='all'?{...edits,...data.scopes[business]}:{...data.scopes.all,...(scope===business?edits:data.scopes[business])};}
    function send(){if(data)frame.contentWindow?.postMessage({type:'copy-config',texts:merged(),selecting:find('#copy-pick').checked},location.origin);}
    function open(){frame.src='/?copy-preview='+encodeURIComponent(find('#copy-business').value);}
    function select(key){selected=key;find('#copy-key').value=key;find('#copy-value').value=merged()[key]??key;}
    function drawList(){const search=find('#copy-search').value.toLowerCase();find('#copy-list').replaceChildren();for(const entry of list.filter(e=>(e.key+' '+e.value).toLowerCase().includes(search))){const b=document.createElement('button');b.type='button';b.className='copy-list-item';b.textContent=entry.value||'(빈 문구)';b.onclick=()=>select(entry.key);find('#copy-list').append(b);}}
    const listener=event=>{
      if(!target.isConnected){window.removeEventListener('message',listener);return;}
      if(event.origin!==location.origin||event.source!==frame.contentWindow)return;
      if(event.data.type==='copy-ready'){send();frame.contentWindow.postMessage({type:'copy-page',view:find('#copy-page').value},location.origin);}
      if(event.data.type==='copy-list'){list=event.data.entries;drawList();}
      if(event.data.type==='copy-select')select(event.data.key);
    };
    window.addEventListener('message',listener);
    frame.onload=()=>{send();frame.contentWindow.postMessage({type:'copy-page',view:find('#copy-page').value},location.origin);};
    find('#copy-page').onchange=()=>frame.contentWindow.postMessage({type:'copy-page',view:find('#copy-page').value},location.origin);
    find('#copy-business').onchange=open;
    find('#copy-pick').onchange=send;
    find('#copy-search').oninput=drawList;
    let previousScope='all';
    find('#copy-scope').onchange=()=>{if(dirty&&!confirm('저장하지 않은 문구 변경을 버리고 적용 범위를 바꿀까요?')){find('#copy-scope').value=previousScope;return;}previousScope=find('#copy-scope').value;edits={...data.scopes[previousScope]};dirty=false;selected='';find('#copy-key').value='';find('#copy-value').value='';if(previousScope!=='all'){find('#copy-business').value=previousScope;open();}send();status('선택한 적용 범위의 문구를 편집합니다.');};
    find('#copy-apply').onclick=()=>{if(!selected)return status('먼저 미리보기에서 글씨를 선택하세요.');const value=find('#copy-value').value;const slots=s=>(s.match(/\{[a-zA-Z_]+\}/g)||[]).sort().join();if(slots(value)!==slots(selected))return status('자동 표시 항목을 유지해 주세요.');edits[selected]=value;dirty=true;send();status('변경됨 · 문구 저장을 누르면 사이트에 반영됩니다.');};
    find('#copy-reset').onclick=()=>{if(!selected)return;delete edits[selected];dirty=true;send();select(selected);status('복원 대기 · 저장하면 적용됩니다.');};
    find('#copy-save').onclick=async()=>{const button=find('#copy-save');button.disabled=true;try{data=await api('/api/admin/interface-copy',{method:'PUT',body:JSON.stringify({revision:data.revision,scope:find('#copy-scope').value,texts:edits})});settings=data;dirty=false;schedule();send();status('저장했습니다. 새로고침 후에도 유지됩니다.');}catch(e){status(e.message);}finally{button.disabled=false;}};
    api('/api/admin/interface-copy').then(value=>{if(!target.isConnected)return;data=value;edits={...data.scopes.all};open();}).catch(e=>status(e.message));
  }
  document.addEventListener('DOMContentLoaded',()=>{
    document.body.dataset.adminTheme=localStorage.getItem('inventoryAdminTheme')==='light'?'light':'dark';
    const theme=document.createElement('label');theme.className='admin-theme-control';theme.innerHTML='<button type="button" class="button ghost theme-toggle" aria-label="관리자 테마 전환"></button><select aria-label="관리자 테마" hidden><option value="light">라이트</option><option value="dark">다크</option></select>';
    document.querySelector('.top-actions').prepend(theme);theme.querySelector('select').value=document.body.dataset.adminTheme;
    const updateTheme=()=>{const dark=document.body.dataset.adminTheme==='dark';theme.querySelector('button').innerHTML=dark?'☀':'☾';theme.querySelector('button').title=dark?'라이트 모드로 전환':'다크 모드로 전환';theme.querySelector('button').setAttribute('aria-label',dark?'라이트 모드로 전환':'다크 모드로 전환');};
    theme.querySelector('select').onchange=e=>{document.body.dataset.adminTheme=e.target.value;localStorage.setItem('inventoryAdminTheme',e.target.value);updateTheme();};
    theme.querySelector('button').onclick=()=>{const select=theme.querySelector('select');select.value=document.body.dataset.adminTheme==='dark'?'light':'dark';select.dispatchEvent(new Event('change'));};updateTheme();
    new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-admin','data-theme','placeholder','aria-label','title']});
    schedule();
    if(preview){
      document.body.classList.add('copy-preview-mode');
      document.addEventListener('click',e=>{if(!selecting)return;const entry=entries.find(x=>x.el===e.target)||entries.find(x=>e.target.contains(x.el));e.preventDefault();e.stopImmediatePropagation();if(entry)parent.postMessage({type:'copy-select',key:entry.key},location.origin);},true);
      window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==parent)return;const data=event.data;if(data.type==='copy-config'){draft=data.texts;selecting=data.selecting;document.body.classList.toggle('copy-selecting',selecting);schedule();}if(data.type==='copy-page'&&data.view!=='admin'){setView(data.view);schedule();}});
    }
  });
  return {preview,load,editor,applyPreview:apply,ready(){if(preview)parent.postMessage({type:'copy-ready'},location.origin);}};
})();
