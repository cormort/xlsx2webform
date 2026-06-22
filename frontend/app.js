const isFillMode = !!(window.FILL_TOKEN);
const isEditorMode = !!(window.EDIT_SESSION_ID);
const isLanding = window.LANDING_MODE === 'projects';
const fillToken = window.FILL_TOKEN || '';
const editSessionId = window.EDIT_SESSION_ID || '';

// ===== State =====
let sessionId = null;
let data = [];
let original = [];
let isDirty = false;
let fundNames = [];
let fillFundCol = 0;
let selectedCell = null;
let editMode = false;
const checkedRows = new Set();
const checkedCols = new Set();
// ponytail: undo is full JSON snapshots, swap to diff-based if memory matters
const undoStack = [];
const MAX_UNDO = 50;
let selectionStart = null; // {r,c} for merge selection
let selectionEnd = null;

function pushUndo(){
    undoStack.push(JSON.parse(JSON.stringify(data)));
    if(undoStack.length>MAX_UNDO) undoStack.shift();
}
function undo(){
    if(!undoStack.length){toast('沒有可還原的操作',1);return}
    data=undoStack.pop();
    recalcAll();render();isDirty=true;
}

// ===== Admin Auth Helpers =====
const adminRequired = !!(window.ADMIN_REQUIRED);
function getAdminToken(){ return sessionStorage.getItem('admin_token')||'' }
function setAdminToken(t){ if(t) sessionStorage.setItem('admin_token',t); else sessionStorage.removeItem('admin_token') }

// ===== Helpers =====
function getAuthHeaders(customHeaders = {}){
    const headers={...customHeaders};
    const sid=sessionId||editSessionId;
    const pwd=sessionStorage.getItem('project_password_'+sid);
    if(pwd) headers['X-Project-Password']=pwd;
    const adminTk=getAdminToken();
    if(adminTk) headers['X-Admin-Token']=adminTk;
    return headers;
}
function escapeHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function parseNum(v){const n=parseFloat(String(v).replace(/,/g,''));return isNaN(n)?null:n}
function fmtNum(n){if(n===null||isNaN(n))return '';const p=n%1===0?0:2;return n.toLocaleString('en-US',{minimumFractionDigits:p,maximumFractionDigits:2})}
function toast(msg,err){const el=document.getElementById('toast-msg');el.textContent=msg;const t=document.getElementById('toast');t.className='toast show'+(err?' err':'');setTimeout(()=>t.className='toast',2500)}
function alpha(c){let s='';let n=c;while(n>=0){s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)-1}return s||'A'}
function cellRef(r,c){return alpha(c)+r}
function parseRef(s){const m=s.match(/^([A-Z]+)(\d+)$/i);if(!m)return null;const col=m[1].toUpperCase().split('').reduce((a,ch)=>a*26+ch.charCodeAt(0)-64,0)-1;const row=parseInt(m[2]);return{r:row,c:col}}

async function downloadXlsxFile(name, payloadData, filename) {
    // Normalize data to ensure all cells are objects and have row and col properties
    const normalizedData = (payloadData || []).map((row, ri) => {
        if (!Array.isArray(row)) return [];
        return row.map((cell, ci) => {
            const cObj = (cell && typeof cell === 'object') ? cell : { value: String(cell || '') };
            return {
                ...cObj,
                row: cObj.row || (ri + 1),
                col: cObj.col || (ci + 1)
            };
        });
    });

    try {
        const r = await fetch('/api/export-xlsx', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, data: normalizedData })
        });
        if (!r.ok) throw new Error('匯出 XLSX 失敗');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch(e) {
        toast(e.message, 1);
    }
}

function detectLevel(name){
    if(!name)return 1;const n=String(name).trim();if(!n)return 1;
    if(/^\s{4,}/.test(n))return 3;
    if(/^\s{2}/.test(n)||/^[（(][一二三四五六七八九十]+[）)]/.test(n))return 2;
    if(/^[一二三四五六七八九十]+[、.]/.test(n))return 1;
    if(/^\d+[.、]/.test(n)||/^[（(]\d+[）)]/.test(n))return 2;
    return 1;
}

function isNumericCol(colIdx){
    let n=0,t=0;
    for(let r=1;r<Math.min(data.length,15);r++){const v=data[r]?.[colIdx]?.value;if(v){t++;if(parseNum(v)!==null)n++}}
    return t>0&&n/t>0.3;
}

function getNumerics(){const nc=[];if(!data.length)return nc;for(let c=0;c<Math.max(...data.map(r=>r.length));c++)if(isNumericCol(c))nc.push(c);return nc}
function getHeaders(){if(!data.length)return[];return(data[0]||[]).map(c=>c?c.value||'':'')}

function recalcAutoSum(){
    const nodes=[];
    for(let r=1;r<data.length;r++){const n=data[r]?.[0]?.value||'';nodes.push({idx:r,level:detectLevel(n),name:n,children:[],parent:null})}
    for(let i=0;i<nodes.length;i++){if(nodes[i].level<=1)continue;for(let j=i-1;j>=0;j--){if(nodes[j].level<nodes[i].level&&nodes[j].level>0){nodes[j].children.push(nodes[i]);nodes[i].parent=nodes[j];break}}}
    const nums=getNumerics();
    function process(node){
        node.children.forEach(process);
        if(!node.children.length)return;
        nums.forEach(ci=>{let s=0,h=false;node.children.forEach(ch=>{const v=parseNum(data[ch.idx]?.[ci]?.value);if(v!==null){s+=v;h=true}});if(h&&s!==0){const c=data[node.idx]?.[ci];if(c){c.value=String(s);c._autoSum=true;c._formula=''}}});
    }
    nodes.filter(n=>!n.parent).forEach(process);
}

// Safe arithmetic evaluator (no Function() — prevents XSS/code injection)
function safeEval(expr) {
    // Tokenize: numbers, operators, parentheses
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        if (/\s/.test(expr[i])) { i++; continue; }
        if (/[\d.]/.test(expr[i])) {
            let num = '';
            while (i < expr.length && /[\d.]/.test(expr[i])) num += expr[i++];
            tokens.push({ type: 'num', value: parseFloat(num) });
        } else if ('+-*/'.includes(expr[i])) {
            tokens.push({ type: 'op', value: expr[i++] });
        } else if (expr[i] === '(') {
            tokens.push({ type: 'lparen' }); i++;
        } else if (expr[i] === ')') {
            tokens.push({ type: 'rparen' }); i++;
        } else {
            return NaN; // disallow anything else
        }
    }
    // Recursive descent parser
    let pos = 0;
    function peek() { return tokens[pos]; }
    function consume() { return tokens[pos++]; }
    function parseExpr() {
        let left = parseTerm();
        while (peek() && peek().type === 'op' && '+-'.includes(peek().value)) {
            const op = consume().value;
            const right = parseTerm();
            left = op === '+' ? left + right : left - right;
        }
        return left;
    }
    function parseTerm() {
        let left = parseFactor();
        while (peek() && peek().type === 'op' && '*/'.includes(peek().value)) {
            const op = consume().value;
            const right = parseFactor();
            left = op === '*' ? left * right : left / right;
        }
        return left;
    }
    function parseFactor() {
        const t = peek();
        if (!t) return NaN;
        if (t.type === 'num') { consume(); return t.value; }
        if (t.type === 'op' && t.value === '-') { consume(); return -parseFactor(); }
        if (t.type === 'op' && t.value === '+') { consume(); return parseFactor(); }
        if (t.type === 'lparen') {
            consume();
            const val = parseExpr();
            if (peek() && peek().type === 'rparen') consume();
            return val;
        }
        return NaN;
    }
    const result = parseExpr();
    if (pos < tokens.length) return NaN;
    return result;
}

// Column letters → 0-based index (A=0, B=1, AA=26 …), matching the column dropdown.
function colLettersToIndex(letters){
    return letters.toUpperCase().split('').reduce((a,ch)=>a*26+(ch.charCodeAt(0)-64),0)-1;
}
// Kill floating-point noise (0.1+0.2 → 0.3) without harming legitimate decimals.
function roundNum(n){return Math.round((n+(n>=0?Number.EPSILON:-Number.EPSILON))*1e10)/1e10}

// Resolve a formula body into a pure arithmetic expression for cell (curR,curC).
// Supports absolute cell refs (A2, B10) AND per-row column refs (A, B).
function resolveFormulaExpr(body,curR,curC){
    // 1) Absolute cell refs: column letters immediately followed by a row number.
    let expr=body.replace(/([A-Za-z]+)(\d+)/g,(m,letters,digits)=>{
        const col=colLettersToIndex(letters),row=parseInt(digits,10);
        if(row===curR&&col===curC)return '0';              // self-reference guard
        const v=parseNum(data[row]?.[col]?.value);
        return v===null?'0':String(v);
    });
    // 2) Remaining bare letters = per-row column refs (use the current row).
    expr=expr.replace(/[A-Za-z]+/g,(m)=>{
        const col=colLettersToIndex(m);
        if(col===curC)return '0';                          // self-column guard
        const v=parseNum(data[curR]?.[col]?.value);
        return v===null?'0':String(v);
    });
    return expr;
}

// Evaluate one cell's formula. Returns a finite number, or NaN if invalid/div-by-zero.
function evalFormula(curR,curC,formula){
    const body=formula&&formula.startsWith('=')?formula.slice(1):'';
    if(!body.trim())return NaN;
    const res=safeEval(resolveFormulaExpr(body,curR,curC));
    return (typeof res==='number'&&isFinite(res))?roundNum(res):NaN;
}

// Apply a formula to a whole column, or to a single row when onlyRow is given.
function applyFormula(colIdx,formula,onlyRow){
    const start=onlyRow!=null?onlyRow:1;
    const end=onlyRow!=null?onlyRow+1:data.length;
    for(let r=start;r<end;r++){
        const cell=data[r]?.[colIdx];if(!cell)continue;if(cell._autoSum)continue;
        const body=formula.startsWith('=')?formula.slice(1):'';
        if(!body){cell._formula='';continue}               // empty formula clears it
        cell._formula=formula;
        const res=evalFormula(r,colIdx,formula);
        cell.value=(typeof res==='number'&&!isNaN(res))?String(res):'';
    }
}

// Re-evaluate every stored formula cell against current source values (live recalc).
function recalcFormulas(){
    for(let r=1;r<data.length;r++){
        const row=data[r];if(!row)continue;
        for(let c=0;c<row.length;c++){
            const cell=row[c];
            if(!cell||!cell._formula||cell._autoSum)continue;
            const res=evalFormula(r,c,cell._formula);
            cell.value=(typeof res==='number'&&!isNaN(res))?String(res):'';
        }
    }
}

// Full recompute: iterate formulas + hierarchy auto-sum to a fixed point.
// The iteration cap (12) protects against circular references.
function recalcAll(){
    for(let i=0;i<12;i++){
        const snap=JSON.stringify(data.map(row=>row?row.map(c=>c?c.value:''):[]));
        recalcFormulas();
        recalcAutoSum();
        if(JSON.stringify(data.map(row=>row?row.map(c=>c?c.value:''):[]))===snap)break;
    }
}

// ===== Init =====
if(isFillMode){
    document.getElementById('projects-section').style.display='none';
    document.getElementById('editor').style.display='none';
    document.getElementById('fill-banner').style.display='block';
    document.getElementById('app-title').textContent='填寫表單';
    initFillMode();
} else if(isEditorMode){
    document.getElementById('projects-section').style.display='none';
    document.getElementById('editor').style.display='block';
    document.getElementById('back-link').style.display='inline';
    initEditorWithSession(editSessionId);
} else {
    initProjectsPage();
}

// ===== Admin Login UI & Layout Functions =====
function authLogout(){
    fetch('/api/auth/logout',{method:'POST',headers:getAuthHeaders()}).finally(()=>{
        setAdminToken('');
        sessionStorage.removeItem('auth_role');
        sessionStorage.removeItem('auth_email');
        location.reload();
    });
}
window.authLogout = authLogout;

function showChangePassword(){
    const old_pw = prompt('請輸入目前密碼：');
    if(!old_pw) return;
    const new_pw = prompt('請輸入新密碼：');
    if(!new_pw) return;
    fetch('/api/auth/change-password',{method:'PUT',headers:{...getAuthHeaders(),'Content-Type':'application/json'},body:JSON.stringify({old_password:old_pw,new_password:new_pw})})
        .then(r=>{if(!r.ok) return r.json().then(e=>{throw new Error(e.detail||'失敗')}); return r.json()})
        .then(()=>alert('密碼已更新'))
        .catch(e=>alert(e.message));
}
window.showChangePassword = showChangePassword;

function renderIdentity(role, email){
    const box = document.getElementById('identity');
    if(!box) return;
    // Only show when authenticated (token present, or admin not required)
    const authed = !!getAdminToken() || !adminRequired;
    if(!authed || !role){ box.style.display='none'; box.innerHTML=''; return; }
    const roleLabel = role === 'admin' ? '管理員' : role === 'dgbas' ? '主計總處' : '使用者';
    const roleClass = (role === 'admin' || role === 'dgbas') ? 'badge-role admin' : 'badge-role';
    const who = email
        ? `<span class="who"><span class="${roleClass}">${roleLabel}</span><span class="email" title="${escapeHtml(email)}">${escapeHtml(email)}</span></span>`
        : `<span class="who"><span class="${roleClass}">${roleLabel}</span></span>`;
    const changePwdBtn = (role === 'user' || role === 'dgbas') ? `<button class="btn btn-outline" onclick="showChangePassword()" style="padding:6px 14px;background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.25)">改密碼</button>` : '';
    box.innerHTML = `${who}${changePwdBtn}<button class="btn btn-outline" onclick="authLogout()" style="padding:6px 14px;background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.25)">登出</button>`;
    box.style.display = 'flex';
}

function currentRole() {
    return sessionStorage.getItem('auth_role') || (!adminRequired ? 'admin' : null);
}
// 主計總處: elevated, read-only over projects/templates
function isReadOnly() { return currentRole() === 'dgbas'; }

function updateAdminLayout() {
    const role = currentRole();
    const email = sessionStorage.getItem('auth_email');
    const adminTabs = document.getElementById('admin-tabs');
    const userMgmtView = document.getElementById('user-management-view');
    const projectMgmtView = document.getElementById('project-management-view');

    // Render identity bar (role + email + logout)
    renderIdentity(role, email);

    document.body.classList.toggle('role-dgbas', role === 'dgbas');

    if (role === 'admin' || role === 'dgbas') {
        if (adminTabs) adminTabs.style.display = 'flex';
        // 主計總處 cannot use the admin-only 基金管理 / 總彙整 tabs
        const dg = role === 'dgbas';
        ['tab-fund-mgmt', 'tab-consolidate'].forEach(id => {
            const t = document.getElementById(id);
            if (t) t.style.display = dg ? 'none' : '';
        });
        const auditTab = document.getElementById('tab-audit');
        if (auditTab) auditTab.style.display = '';   // visible to admin + 主計總處
        // Make sure we are on the project tab by default
        switchTab('project-mgmt');
    } else {
        if (adminTabs) adminTabs.style.display = 'none';
        if (userMgmtView) userMgmtView.style.display = 'none';
        if (projectMgmtView) projectMgmtView.style.display = 'block';
    }

    autoFillUploadEmail();
}

function autoFillUploadEmail() {
    const role = sessionStorage.getItem('auth_role');
    const email = sessionStorage.getItem('auth_email') || '';
    const emailInput = document.getElementById('project-email');
    if (emailInput) {
        if (role === 'user' && email) {
            emailInput.value = email;
            emailInput.disabled = true;
        } else {
            emailInput.disabled = false;
        }
    }
}

function switchTab(tabId) {
    const map = {
        'project-mgmt': ['tab-project-mgmt', 'project-management-view', loadProjects],
        'user-mgmt':    ['tab-user-mgmt', 'user-management-view', loadUsers],
        'fund-mgmt':    ['tab-fund-mgmt', 'fund-management-view', loadFundMgmt],
        'template-mgmt':['tab-template-mgmt', 'template-management-view', loadTemplates],
        'consolidate':  ['tab-consolidate', 'consolidate-view', loadConsolidate],
        'audit':        ['tab-audit', 'audit-view', loadAudit],
        'guide':        ['tab-guide', 'guide-view', null],
    };
    if (!document.getElementById('tab-project-mgmt')) return;
    Object.entries(map).forEach(([k, [tabIdEl, viewId]]) => {
        const tab = document.getElementById(tabIdEl);
        const view = document.getElementById(viewId);
        if (tab) tab.classList.toggle('active', k === tabId);
        if (view) view.style.display = (k === tabId) ? 'block' : 'none';
    });
    const fn = map[tabId] && map[tabId][2];
    if (fn) fn();
}

// ── Supervisor (主管機關) select helpers ──
let _supervisors = null;
async function loadSupervisors() {
    if (_supervisors) return _supervisors;
    try {
        const r = await fetch('/api/supervisors', { headers: getAuthHeaders() });
        const res = await r.json();
        _supervisors = res.supervisors || [];
    } catch (e) { _supervisors = []; }
    return _supervisors;
}
function fillSupervisorSelect(sel, selectedVal) {
    if (!sel || !_supervisors) return;
    const byDom = {};
    _supervisors.forEach(s => { (byDom[s.domain_label] = byDom[s.domain_label] || []).push(s); });
    let h = '<option value="">— 選擇主管機關 —</option>';
    Object.entries(byDom).forEach(([label, arr]) => {
        h += `<optgroup label="${escapeHtml(label)}">`;
        arr.sort((a, b) => a.code.localeCompare(b.code)).forEach(s => {
            const v = `${s.domain}|${s.code}`;
            h += `<option value="${v}"${v === selectedVal ? ' selected' : ''}>${s.code} ${escapeHtml(s.name)}</option>`;
        });
        h += '</optgroup>';
    });
    sel.innerHTML = h;
}

let _usersCache = [];
async function loadUsers() {
    const listBody = document.getElementById('users-list-body');
    if (!listBody) return;
    listBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#94a3b8">載入中⋯</td></tr>';
    try {
        await loadSupervisors();
        const r = await fetch('/api/admin/users', { headers: getAuthHeaders() });
        const res = await r.json();
        if (!r.ok) throw new Error(res.detail || '載入失敗');
        _usersCache = res.users || [];
        if (!_usersCache.length) {
            listBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#94a3b8">尚無使用者</td></tr>';
            return;
        }
        const dash = '<span style="color:var(--border)">—</span>';
        let h = '';
        const dg = isReadOnly();   // current user is 主計總處
        _usersCache.forEach(u => {
            const roleTag = u.role === 'dgbas' ? ' <span class="badge-pill" style="background:#fef3c7;color:#92400e">主計總處</span>' : '';
            const sup = (u.supervisor ? `${u.supervisor.code} ${escapeHtml(u.supervisor.name)}` : dash) + roleTag;
            const agency = u.agency_name ? escapeHtml(u.agency_name) : dash;
            // Only admins can grant/revoke the 主計總處 role
            const roleBtn = (currentRole() === 'admin')
                ? (u.role === 'dgbas'
                    ? `<button class="btn btn-outline" onclick="setUserRole('${escapeHtml(u.email)}','')" title="取消主計總處權限">取消主計總處</button>`
                    : `<button class="btn btn-outline" onclick="setUserRole('${escapeHtml(u.email)}','dgbas')" title="授予主計總處權限">設為主計總處</button>`)
                : '';
            // 主計總處 cannot manage other 主計總處 accounts (server also enforces)
            const actions = (dg && u.role === 'dgbas')
                ? '<span style="color:var(--text-muted);font-size:12px">—</span>'
                : `${roleBtn}<button class="btn btn-outline" onclick="editUser('${escapeHtml(u.email)}')" title="編輯機關資料">編輯</button>
                    <button class="btn btn-outline-red" onclick="deleteUser('${escapeHtml(u.email)}')" title="刪除">刪除</button>`;
            h += `<tr>
                <td style="padding:10px 14px">${sup}</td>
                <td style="padding:10px 14px">${agency}</td>
                <td style="padding:10px 14px;font-weight:600">${escapeHtml(u.email)}</td>
                <td style="padding:10px 14px;color:var(--text-soft)">${u.created_at?.split('T')[0] || ''}</td>
                <td class="text-center nowrap" style="padding:10px 14px">${actions}</td>
            </tr>`;
        });
        listBody.innerHTML = h;
    } catch(e) {
        listBody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#dc2626">${escapeHtml(e.message)}</td></tr>`;
    }
}

window.editUser = async function(email) {
    await loadSupervisors();
    const u = _usersCache.find(x => x.email === email);
    document.getElementById('edit-user-email').textContent = email;
    document.getElementById('btn-submit-edit-user').dataset.email = email;
    const selVal = (u && u.supervisor) ? `${u.supervisor.domain}|${u.supervisor.code}` : '';
    fillSupervisorSelect(document.getElementById('edit-user-supervisor'), selVal);
    document.getElementById('edit-user-agency').value = (u && u.agency_name) || '';
    document.getElementById('edit-user-dialog').classList.add('show');
};

// ── Template Management (範本管理) ──
let _allTemplates = [];

async function loadTemplates() {
    const list = document.getElementById('template-list');
    if (!list) return;
    list.innerHTML = '<p style="padding:24px;color:#94a3b8;text-align:center">載入中⋯</p>';
    try {
        const r = await fetch('/api/templates', { headers: getAuthHeaders() });
        const res = await r.json();
        _allTemplates = res.templates || [];
    } catch(e) {
        list.innerHTML = '<p style="padding:24px;color:#e74c3c;text-align:center">載入失敗</p>';
        return;
    }
    const supSet = new Set(), emailSet = new Set();
    _allTemplates.forEach(t => {
        if (t.supervisor_name) supSet.add(t.supervisor_name);
        if (t.creator_email) emailSet.add(t.creator_email);
    });
    const supSel = document.getElementById('tpl-filter-supervisor');
    const emailSel = document.getElementById('tpl-filter-email');
    if (supSel) {
        const cur = supSel.value;
        supSel.innerHTML = '<option value="">全部主管機關</option>' + [...supSet].sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
        supSel.value = cur || '';
        supSel.onchange = renderTemplateList;
    }
    if (emailSel) {
        const cur = emailSel.value;
        emailSel.innerHTML = '<option value="">全部使用者</option>' + [...emailSet].sort().map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
        emailSel.value = cur || '';
        emailSel.onchange = renderTemplateList;
    }
    renderTemplateList();
}

function renderTemplateList() {
    const list = document.getElementById('template-list');
    if (!list) return;
    const fSup = document.getElementById('tpl-filter-supervisor')?.value || '';
    const fEmail = document.getElementById('tpl-filter-email')?.value || '';
    let rows = _allTemplates.filter(t => {
        if (fSup && (t.supervisor_name || '') !== fSup) return false;
        if (fEmail && (t.creator_email || '') !== fEmail) return false;
        return true;
    });
    rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (!rows.length) {
        list.innerHTML = '<p style="padding:24px;color:#94a3b8;text-align:center">尚無範本</p>';
        return;
    }
    list.innerHTML = rows.map(t => {
        const dt = (t.created_at || '').replace('T', ' ').slice(0, 16);
        const sup = t.supervisor_name ? `<span class="badge-pill" style="background:#e0f2fe;color:#0369a1">${escapeHtml(t.supervisor_name)}</span>` : '';
        const email = t.creator_email ? `<span style="color:var(--text-soft);font-size:12px">${escapeHtml(t.creator_email)}</span>` : '';
        return `<div class="flex items-center" style="gap:12px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);flex-wrap:wrap">
            <div style="flex:1;min-width:150px">
                <div style="font-weight:600;font-size:14px;color:var(--text-strong);margin-bottom:2px">${escapeHtml(t.name)}</div>
                <div class="flex items-center flex-wrap" style="gap:8px">
                    ${sup}${email}
                    <span style="color:var(--text-muted);font-size:11px">${t.row_count || 0} 列</span>
                    <span style="color:var(--text-muted);font-size:11px">🕒 ${dt}</span>
                </div>
            </div>
            <div class="flex" style="gap:6px">
                ${isReadOnly() ? '' : `<button class="btn btn-primary" onclick="createFromTemplate('${t.id}')">建立專案</button>
                <button class="icon-btn danger" onclick="deleteTemplate('${t.id}')" title="刪除範本">&times;</button>`}
            </div>
        </div>`;
    }).join('');
}

async function saveAsTemplate(sessionId) {
    if (!confirm('將此專案存為範本？')) return;
    try {
        const r = await fetch(`/api/templates/save-from-session/${sessionId}`, { method: 'POST', headers: getAuthHeaders() });
        const res = await r.json();
        if (res.success) {
            toast('已儲存為範本：' + (res.name || ''));
        } else {
            toast('儲存失敗：' + (res.detail || ''), true);
        }
    } catch(e) {
        toast('儲存失敗', true);
    }
}
window.saveAsTemplate = saveAsTemplate;

async function createFromTemplate(templateId) {
    if (!confirm('從此範本建立新專案？')) return;
    try {
        const r = await fetch(`/api/templates/${templateId}/load`, { method: 'POST', headers: getAuthHeaders() });
        const res = await r.json();
        if (res.success) {
            toast('已建立專案');
            location.href = `/editor/${res.session_id}`;
        } else {
            toast('建立失敗：' + (res.detail || ''), true);
        }
    } catch(e) {
        toast('建立失敗', true);
    }
}
window.createFromTemplate = createFromTemplate;

async function deleteTemplate(templateId) {
    if (!confirm('確定刪除此範本？')) return;
    try {
        const r = await fetch(`/api/templates/${templateId}`, { method: 'DELETE', headers: getAuthHeaders() });
        const res = await r.json();
        if (res.success) {
            toast('已刪除範本');
            loadTemplates();
        } else {
            toast('刪除失敗', true);
        }
    } catch(e) {
        toast('刪除失敗', true);
    }
}
window.deleteTemplate = deleteTemplate;

// ── Consolidation (總彙整) ──
let _consolData = null;
async function loadConsolidate() {
    const c = document.getElementById('consolidate-container');
    if (!c) return;
    c.innerHTML = '<p style="padding:24px;color:#94a3b8;text-align:center">載入中⋯</p>';
    try {
        const r = await fetch('/api/consolidate', { headers: getAuthHeaders() });
        const res = await r.json();
        if (!r.ok) throw new Error(res.detail || '載入失敗');
        _consolData = res;
        renderConsolidate(res);
    } catch(e) {
        c.innerHTML = `<p style="padding:24px;color:#dc2626;text-align:center">${escapeHtml(e.message)}</p>`;
    }
}
function renderConsolidate(res) {
    const c = document.getElementById('consolidate-container');
    if (!res.groups || !res.groups.length) {
        c.innerHTML = '<p style="padding:48px;color:var(--text-muted);text-align:center">尚無可彙整的回應資料<br><span style="font-size:var(--fs-sm)">發布表單並收到回應後，這裡會依主管機關 → 機關 → 基金分組彙整</span></p>';
        return;
    }
    let h = `<p class="resp-stats" style="margin-bottom:8px">共 ${res.total_rows} 筆資料列</p>`;
    res.groups.forEach(g => {
        const supLabel = g.supervisor_code ? `${g.supervisor_code} ${escapeHtml(g.supervisor_name)}` : escapeHtml(g.supervisor_name);
        h += `<div class="consol-sup"><div class="consol-sup-h">🏛️ ${supLabel}</div>`;
        g.agencies.forEach(a => {
            h += `<div class="consol-agency"><div class="consol-agency-h">🏢 ${escapeHtml(a.agency)}</div>`;
            a.funds.forEach(f => {
                const fundLabel = f.fund_code ? `${f.fund_code} ${escapeHtml(f.fund_name)}` : escapeHtml(f.fund_name);
                const warn = f.matched ? '' : ' <span title="未對應到官方基金編號" style="color:#d97706;font-size:11px">⚠ 未匹配</span>';
                h += `<div class="consol-fund"><div class="consol-fund-h">${fundLabel} <span style="color:var(--text-muted);font-weight:400">(${f.rows.length} 筆)</span>${warn}</div>`;
                const header = (f.rows[0] && f.rows[0].header) || [];
                h += '<div class="resp-table-wrap"><table class="resp-compare-table"><thead><tr><th>填表機關</th><th>時間</th>';
                header.forEach(hd => h += `<th>${escapeHtml(hd)}</th>`);
                h += '</tr></thead><tbody>';
                f.rows.forEach(row => {
                    h += `<tr><td><strong>${escapeHtml(row.respondent || row.session_name || '')}</strong></td><td class="resp-row-label">${(row.submitted_at || '').replace('T', ' ').slice(0, 16)}</td>`;
                    row.values.forEach(v => h += `<td>${escapeHtml(v)}</td>`);
                    h += '</tr>';
                });
                h += '</tbody></table></div></div>';
            });
            h += '</div>';
        });
        h += '</div>';
    });
    c.innerHTML = h;
}
function exportConsolCSV() {
    if (!_consolData || !_consolData.groups.length) { toast('無資料可匯出', 1); return; }
    const out = [['主管機關碼', '主管機關', '機關名稱', '基金編號', '基金名稱', '是否匹配', '填表機關', '時間', '基金欄原值']];
    _consolData.groups.forEach(g => g.agencies.forEach(a => a.funds.forEach(f => f.rows.forEach(row => {
        out.push([g.supervisor_code, g.supervisor_name, a.agency, f.fund_code, f.fund_name,
                  f.matched ? '是' : '否', row.respondent, row.submitted_at, row.fund_raw]);
    }))));
    const csv = out.map(r => r.map(x => `"${String(x == null ? '' : x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'consolidation.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Audit Log (稽核紀錄) ──
async function loadAudit() {
    const c = document.getElementById('audit-container');
    if (!c) return;
    c.innerHTML = '<p style="padding:24px;color:#94a3b8;text-align:center">載入中⋯</p>';
    const emailF = (document.getElementById('audit-filter-email')?.value || '').trim();
    const actionF = (document.getElementById('audit-filter-action')?.value || '').trim();
    const qs = new URLSearchParams({ limit: '800' });
    if (emailF) qs.set('email', emailF);
    if (actionF) qs.set('action', actionF);
    try {
        const r = await fetch('/api/admin/audit-log?' + qs.toString(), { headers: getAuthHeaders() });
        const res = await r.json();
        if (!r.ok) throw new Error(res.detail || '載入失敗');
        const rows = res.entries || [];
        if (!rows.length) { c.innerHTML = '<p style="padding:48px;color:var(--text-muted);text-align:center">尚無紀錄</p>'; return; }
        const roleLabel = { admin: '管理員', dgbas: '主計總處', user: '使用者', guest: '訪客' };
        let h = `<p class="resp-stats" style="margin-bottom:8px">共 ${rows.length} 筆（最新在上）</p>`;
        h += '<div class="table-wrap"><div class="scroll"><table class="resp-compare-table"><thead><tr><th style="width:150px">時間</th><th>身分</th><th>Email</th><th>IP</th><th>動作</th><th style="width:60px">狀態</th></tr></thead><tbody>';
        rows.forEach(e => {
            h += `<tr><td class="resp-row-label">${escapeHtml((e.ts || '').replace('T', ' '))}</td>`
               + `<td>${escapeHtml(roleLabel[e.role] || e.role || '')}</td>`
               + `<td>${escapeHtml(e.email || '')}</td>`
               + `<td>${escapeHtml(e.ip || '')}</td>`
               + `<td>${escapeHtml(e.action || '')}</td>`
               + `<td>${escapeHtml(e.detail || '')}</td></tr>`;
        });
        h += '</tbody></table></div></div>';
        c.innerHTML = h;
    } catch(e) {
        c.innerHTML = `<p style="padding:24px;color:#dc2626;text-align:center">${escapeHtml(e.message)}</p>`;
    }
}

// ── Supervisor Management (主管機關管理) ──
let _supCache = [];

async function loadSupervisorMgmt() {
    try {
        const r = await fetch('/api/supervisors', { headers: getAuthHeaders() });
        if (!r.ok) throw new Error('載入失敗');
        _supCache = (await r.json()).supervisors || [];
        renderSupMgmtList();
    } catch (e) { toast(e.message, 1); }
}

function renderSupMgmtList() {
    const dom = document.getElementById('sup-mgmt-domain').value;
    const list = _supCache.filter(s => s.domain === dom);
    const el = document.getElementById('sup-mgmt-list');
    if (!list.length) { el.innerHTML = '<p style="color:#94a3b8">此類別尚無主管機關</p>'; return; }
    list.sort((a, b) => a.code.localeCompare(b.code));
    el.innerHTML = list.map(s =>
        `<div class="flex items-center" style="gap:8px;padding:6px 8px;border-bottom:1px solid var(--border)">
            <span style="font-size:12px;color:var(--text-muted);min-width:36px;font-family:monospace">${escapeHtml(s.code)}</span>
            <span style="flex:1;font-size:13px;font-weight:600">${escapeHtml(s.name)}</span>
            <button class="btn btn-outline" style="padding:2px 8px;font-size:11px" onclick="editSup('${escapeHtml(s.domain)}','${escapeHtml(s.code)}','${escapeHtml(s.name)}')">編輯</button>
            <button class="btn btn-outline-red" style="padding:2px 8px;font-size:11px" onclick="deleteSup('${escapeHtml(s.domain)}','${escapeHtml(s.code)}')">刪除</button>
        </div>`
    ).join('');
}

let _supEditing = null; // {domain, code} when editing

function _supEditMode(on, domain, code, name) {
    _supEditing = on ? { domain, code } : null;
    const codeEl = document.getElementById('sup-mgmt-code');
    const nameEl = document.getElementById('sup-mgmt-name');
    const btn = document.getElementById('btn-sup-add');
    const cancel = document.getElementById('btn-sup-cancel');
    const form = document.getElementById('sup-mgmt-form');
    if (on) {
        document.getElementById('sup-mgmt-domain').value = domain;
        codeEl.value = code;
        codeEl.readOnly = true;
        nameEl.value = name;
        btn.textContent = '儲存修改';
        cancel.style.display = '';
        form.style.background = 'var(--warn-soft, #fef9c3)';
        nameEl.focus();
    } else {
        codeEl.value = '';
        codeEl.readOnly = false;
        nameEl.value = '';
        btn.textContent = '＋ 新增 / 修改';
        cancel.style.display = 'none';
        form.style.background = '';
    }
}

window.editSup = function(domain, code, name) {
    _supEditMode(true, domain, code, name);
};

window.cancelSupEdit = function() {
    _supEditMode(false);
};

window.deleteSup = async function(domain, code) {
    if (!confirm(`確定刪除主管機關 ${code}？`)) return;
    try {
        const r = await fetch(`/api/admin/supervisors/${encodeURIComponent(domain)}/${encodeURIComponent(code)}`, {
            method: 'DELETE', headers: getAuthHeaders()
        });
        if (!r.ok) throw new Error((await r.json()).detail || '刪除失敗');
        toast('已刪除');
        loadSupervisorMgmt();
    } catch (e) { toast(e.message, 1); }
};

// ── Fund Management ──
let _fundMgmtData = null;

async function loadFundMgmt() {
    try {
        const r = await fetch('/api/active-funds', { headers: getAuthHeaders() });
        if (!r.ok) throw new Error('載入失敗');
        _fundMgmtData = await r.json();
        renderFundMgmtList();
        renderAliasList();
        loadSupervisorMgmt();
    } catch (e) { toast(e.message, 1); }
}

function renderFundMgmtList() {
    if (!_fundMgmtData) return;
    const dom = document.getElementById('fund-mgmt-domain').value;
    const dd = _fundMgmtData[dom];
    if (!dd || !dd.funds) { document.getElementById('fund-mgmt-list').innerHTML = '<p style="color:#94a3b8">無資料</p>'; return; }
    const funds = dd.funds;
    const totalCount = funds.reduce((n, e) => {
        const kids = (typeof e === 'object' && e.children) ? e.children.length : 0;
        return n + 1 + kids;
    }, 0);
    let h = `<div class="mb-2 text-sm" style="color:var(--text-soft)">${escapeHtml(dd.label)} — 共 ${totalCount} 個基金</div>`;
    h += '<div class="flex flex-col" style="gap:4px">';
    funds.forEach((entry, i) => {
        const name = typeof entry === 'string' ? entry : entry.name;
        const kids = (typeof entry === 'object' && entry.children) ? entry.children : [];
        h += `<div style="background:var(--surface-alt);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
            <div class="flex items-center" style="gap:8px;padding:4px 8px">
                <span style="flex:1;font-size:13px;font-weight:600">${escapeHtml(name)}</span>
                ${kids.length ? `<span style="font-size:11px;color:var(--text-muted)">${kids.length} 分基金</span>` : ''}
                <button class="btn btn-outline" style="padding:2px 6px;font-size:11px;color:var(--text-soft)" onclick="moveFund('${dom}',${i},-1)" title="上移">▲</button>
                <button class="btn btn-outline" style="padding:2px 6px;font-size:11px;color:var(--text-soft)" onclick="moveFund('${dom}',${i},1)" title="下移">▼</button>
                <button class="ico-btn-sm danger" onclick="removeFund('${dom}',${i})">✕</button>
            </div>
            <div style="padding:0 8px 6px 24px;display:flex;flex-direction:column;gap:2px">`;
        kids.forEach((child, ci) => {
            h += `<div class="flex items-center" style="gap:6px;padding:2px 6px;background:var(--surface);border-radius:var(--radius-sm);border:1px solid var(--border)">
                <span style="color:var(--text-muted);font-size:11px">└</span>
                <span style="flex:1;font-size:12px">${escapeHtml(child)}</span>
                <button class="btn btn-outline" style="padding:1px 4px;font-size:9px;color:var(--text-soft)" onclick="moveSubFund(${i},${ci},-1)" title="上移">▲</button>
                <button class="btn btn-outline" style="padding:1px 4px;font-size:9px;color:var(--text-soft)" onclick="moveSubFund(${i},${ci},1)" title="下移">▼</button>
                <button class="ico-btn-sm danger" onclick="removeSubFund(${i},${ci})">✕</button>
            </div>`;
        });
        h += `<div class="flex" style="gap:4px;margin-top:2px">
                <input type="text" placeholder="新增分基金⋯" id="subfund-input-${i}" class="field-inline" style="flex:1;padding:2px 6px;font-size:11px">
                <button class="btn btn-outline" style="padding:2px 8px;font-size:11px" onclick="addSubFund(${i})">＋</button>
            </div>
            </div>
        </div>`;
    });
    h += '</div>';
    document.getElementById('fund-mgmt-list').innerHTML = h;
}

function renderAliasList() {
    if (!_fundMgmtData) return;
    const aliases = _fundMgmtData.aliasMap || {};
    const keys = Object.keys(aliases).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    if (!keys.length) { document.getElementById('alias-mgmt-list').innerHTML = '<p style="color:var(--text-muted)">無別名</p>'; return; }
    let h = '<div class="flex flex-col" style="gap:3px">';
    keys.forEach(k => {
        h += `<div class="flex items-center" style="gap:8px;padding:3px 8px;font-size:12px;background:var(--surface-alt);border-radius:var(--radius-sm);border:1px solid var(--border)">
            <span style="font-weight:600;min-width:80px">${escapeHtml(k)}</span>
            <span style="color:var(--text-soft)">→</span>
            <span style="flex:1">${escapeHtml(aliases[k])}</span>
            <button class="ico-btn-sm" onclick="removeAlias('${escapeHtml(k)}')">✕</button>
        </div>`;
    });
    h += '</div>';
    document.getElementById('alias-mgmt-list').innerHTML = h;
}

function addFund() {
    if (!_fundMgmtData) return;
    const dom = document.getElementById('fund-mgmt-domain').value;
    const inp = document.getElementById('fund-mgmt-add-input');
    const name = inp.value.trim();
    if (!name) { toast('請輸入基金名稱', 1); return; }
    if (!_fundMgmtData[dom]) _fundMgmtData[dom] = { label: dom, funds: [] };
    const funds = _fundMgmtData[dom].funds;
    if (funds.some(e => (typeof e === 'string' ? e : e.name) === name)) { toast('此基金已存在', 1); return; }
    funds.push({ name, children: [] });
    inp.value = '';
    renderFundMgmtList();
    toast('已新增（記得儲存）');
}

function removeFund(dom, idx) {
    if (!_fundMgmtData || !_fundMgmtData[dom]) return;
    const entry = _fundMgmtData[dom].funds[idx];
    const name = typeof entry === 'string' ? entry : entry.name;
    const kids = (typeof entry === 'object' && entry.children) ? entry.children.length : 0;
    const msg = kids ? `確定移除「${name}」及其 ${kids} 個分基金？` : `確定移除「${name}」？`;
    if (!confirm(msg)) return;
    _fundMgmtData[dom].funds.splice(idx, 1);
    renderFundMgmtList();
    toast('已移除（記得儲存）');
}
window.removeFund = removeFund;

function moveFund(dom, idx, dir) {
    if (!_fundMgmtData || !_fundMgmtData[dom]) return;
    const arr = _fundMgmtData[dom].funds;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    renderFundMgmtList();
}
window.moveFund = moveFund;

function addSubFund(parentIdx) {
    if (!_fundMgmtData) return;
    const dom = document.getElementById('fund-mgmt-domain').value;
    const entry = _fundMgmtData[dom].funds[parentIdx];
    if (!entry || typeof entry !== 'object') return;
    const inp = document.getElementById('subfund-input-' + parentIdx);
    const name = inp ? inp.value.trim() : '';
    if (!name) { toast('請輸入分基金名稱', 1); return; }
    if (!entry.children) entry.children = [];
    if (entry.children.includes(name)) { toast('此分基金已存在', 1); return; }
    entry.children.push(name);
    renderFundMgmtList();
    toast('已新增分基金（記得儲存）');
}
window.addSubFund = addSubFund;

function removeSubFund(parentIdx, childIdx) {
    if (!_fundMgmtData) return;
    const dom = document.getElementById('fund-mgmt-domain').value;
    const entry = _fundMgmtData[dom].funds[parentIdx];
    if (!entry || !entry.children) return;
    const name = entry.children[childIdx];
    if (!confirm(`確定移除分基金「${name}」？`)) return;
    entry.children.splice(childIdx, 1);
    renderFundMgmtList();
    toast('已移除（記得儲存）');
}
window.removeSubFund = removeSubFund;

function moveSubFund(parentIdx, childIdx, dir) {
    if (!_fundMgmtData) return;
    const dom = document.getElementById('fund-mgmt-domain').value;
    const entry = _fundMgmtData[dom].funds[parentIdx];
    if (!entry || !entry.children) return;
    const arr = entry.children;
    const newIdx = childIdx + dir;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[childIdx], arr[newIdx]] = [arr[newIdx], arr[childIdx]];
    renderFundMgmtList();
}
window.moveSubFund = moveSubFund;

function addAlias() {
    if (!_fundMgmtData) return;
    const keyInp = document.getElementById('alias-add-key');
    const valInp = document.getElementById('alias-add-val');
    const k = keyInp.value.trim(), v = valInp.value.trim();
    if (!k || !v) { toast('請填寫簡稱和對應全名', 1); return; }
    if (!_fundMgmtData.aliasMap) _fundMgmtData.aliasMap = {};
    _fundMgmtData.aliasMap[k] = v;
    keyInp.value = ''; valInp.value = '';
    renderAliasList();
    toast('已新增別名（記得儲存）');
}

function removeAlias(key) {
    if (!_fundMgmtData || !_fundMgmtData.aliasMap) return;
    if (!confirm(`確定移除別名「${key}」？`)) return;
    delete _fundMgmtData.aliasMap[key];
    renderAliasList();
    toast('已移除（記得儲存）');
}
window.removeAlias = removeAlias;

async function saveFundMgmt() {
    if (!_fundMgmtData) return;
    try {
        const r = await fetch('/api/active-funds', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(_fundMgmtData)
        });
        if (!r.ok) throw new Error('儲存失敗');
        toast('基金清單已儲存');
    } catch (e) { toast(e.message, 1); }
}

async function deleteUser(email) {
    if (!confirm(`確定要刪除使用者 ${email} 嗎？\n該使用者的現有登入 Token 將會失效。`)) return;
    try {
        const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        const res = await r.json();
        if (!r.ok) throw new Error(res.detail || '刪除失敗');
        toast('使用者已刪除');
        loadUsers();
    } catch(e) {
        toast(e.message, 1);
    }
}
window.deleteUser = deleteUser;

async function setUserRole(email, role) {
    const msg = role === 'dgbas'
        ? `確定將 ${email} 設為「主計總處」？\n該帳號將可唯讀檢視所有專案/範本，並管理一般使用者。`
        : `確定取消 ${email} 的「主計總處」權限？`;
    if (!confirm(msg + '\n變更後該帳號需重新登入。')) return;
    try {
        const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}/role`, {
            method: 'PUT',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ role })
        });
        const res = await r.json();
        if (!r.ok) throw new Error(res.detail || '設定失敗');
        toast(role === 'dgbas' ? '已設為主計總處' : '已取消主計總處權限');
        loadUsers();
    } catch(e) {
        toast(e.message, 1);
    }
}
window.setUserRole = setUserRole;

(function bindAdminLogin(){
    const overlay=document.getElementById('admin-overlay');
    const emailInput=document.getElementById('admin-email-input');
    const passwordInput=document.getElementById('admin-password-input');
    const btn=document.getElementById('btn-admin-login');
    if(!overlay||!passwordInput||!btn)return;

    btn.addEventListener('click',async()=>{
        const email=emailInput.value.trim();
        const pwd=passwordInput.value.trim();
        if(!pwd){toast('請輸入密碼',1);return}
        try{
            const r=await fetch('/api/auth/login',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({email:email,password:pwd})
            });
            const res=await r.json();
            if(!r.ok) throw new Error(res.detail||'登入失敗');
            setAdminToken(res.token);
            sessionStorage.setItem('auth_role',res.role);
            if(res.email) {
                sessionStorage.setItem('auth_email',res.email);
            } else {
                sessionStorage.removeItem('auth_email');
            }
            overlay.style.display='none';
            emailInput.value='';
            passwordInput.value='';
            toast('登入成功');
            updateAdminLayout();
            if (window.LANDING_MODE === "create") {
                autoFillUploadEmail();
            } else {
                loadProjects();
            }
        }catch(e){
            toast(e.message,1);
        }
    });
    passwordInput.addEventListener('keydown',e=>{
        if(e.key==='Enter') btn.click();
    });
    emailInput.addEventListener('keydown',e=>{
        if(e.key==='Enter') btn.click();
    });
})();

(function bindAddUserEvents() {
    const closeBtn = document.getElementById('close-add-user');
    const submitBtn = document.getElementById('btn-submit-new-user');
    const dialog = document.getElementById('add-user-dialog');
    if (!closeBtn || !submitBtn || !dialog) return;

    closeBtn.addEventListener('click', () => dialog.classList.remove('show'));
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.classList.remove('show'); });

    submitBtn.addEventListener('click', async () => {
        const email = document.getElementById('new-user-email').value.trim();
        const password = document.getElementById('new-user-password').value.trim();
        if (!email || !password) {
            toast('Email 與密碼皆為必填項目', 1);
            return;
        }
        const supVal = document.getElementById('new-user-supervisor').value;
        const [dom, code] = supVal ? supVal.split('|') : ['', ''];
        const agency = document.getElementById('new-user-agency').value.trim();
        const isDgbas = document.getElementById('new-user-dgbas').checked;
        try {
            const r = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ email, password, supervisor_domain: dom, supervisor_code: code, agency_name: agency })
            });
            const res = await r.json();
            if (!r.ok) throw new Error(res.detail || '建立失敗');
            if (isDgbas) {
                await fetch(`/api/admin/users/${encodeURIComponent(email)}/role`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                    body: JSON.stringify({ role: 'dgbas' })
                });
            }
            toast('使用者建立成功');
            dialog.classList.remove('show');
            document.getElementById('new-user-email').value = '';
            document.getElementById('new-user-password').value = '';
            document.getElementById('new-user-supervisor').value = '';
            document.getElementById('new-user-agency').value = '';
            document.getElementById('new-user-dgbas').checked = false;
            loadUsers();
        } catch(e) {
            toast(e.message, 1);
        }
    });
})();

(function bindEditUserEvents() {
    const closeBtn = document.getElementById('close-edit-user');
    const submitBtn = document.getElementById('btn-submit-edit-user');
    const dialog = document.getElementById('edit-user-dialog');
    if (!closeBtn || !submitBtn || !dialog) return;
    closeBtn.addEventListener('click', () => dialog.classList.remove('show'));
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.classList.remove('show'); });
    submitBtn.addEventListener('click', async () => {
        const email = submitBtn.dataset.email;
        const supVal = document.getElementById('edit-user-supervisor').value;
        const [dom, code] = supVal ? supVal.split('|') : ['', ''];
        const agency = document.getElementById('edit-user-agency').value.trim();
        try {
            const r = await fetch(`/api/admin/users/${encodeURIComponent(email)}/profile`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ email, password: '', supervisor_domain: dom, supervisor_code: code, agency_name: agency })
            });
            const res = await r.json();
            if (!r.ok) throw new Error(res.detail || '儲存失敗');
            toast('已更新機關資料');
            dialog.classList.remove('show');
            loadUsers();
        } catch(e) { toast(e.message, 1); }
    });
})();

// ===== Projects Page =====
function initProjectsPage(){
    const isCreateMode = window.LANDING_MODE === "create";

    const tabProject = document.getElementById('tab-project-mgmt');
    const tabUser = document.getElementById('tab-user-mgmt');
    const tabFund = document.getElementById('tab-fund-mgmt');
    const tabConsol = document.getElementById('tab-consolidate');
    if (tabProject && tabUser) {
        tabProject.addEventListener('click', () => switchTab('project-mgmt'));
        tabUser.addEventListener('click', () => switchTab('user-mgmt'));
    }
    if (tabFund) tabFund.addEventListener('click', () => switchTab('fund-mgmt'));
    const tabTpl = document.getElementById('tab-template-mgmt');
    if (tabTpl) tabTpl.addEventListener('click', () => switchTab('template-mgmt'));
    if (tabConsol) tabConsol.addEventListener('click', () => switchTab('consolidate'));
    const tabAudit = document.getElementById('tab-audit');
    if (tabAudit) tabAudit.addEventListener('click', () => switchTab('audit'));
    const tabGuide = document.getElementById('tab-guide');
    if (tabGuide) tabGuide.addEventListener('click', () => switchTab('guide'));

    const btnAddUser = document.getElementById('btn-add-user');
    if (btnAddUser) {
        btnAddUser.addEventListener('click', async () => {
            await loadSupervisors();
            fillSupervisorSelect(document.getElementById('new-user-supervisor'), '');
            const roleRow = document.getElementById('new-user-role-row');
            if (roleRow) roleRow.style.display = currentRole() === 'admin' ? '' : 'none';
            document.getElementById('add-user-dialog').classList.add('show');
        });
    }

    // Consolidation controls
    document.getElementById('btn-consol-refresh')?.addEventListener('click', loadConsolidate);
    document.getElementById('btn-consol-export')?.addEventListener('click', exportConsolCSV);

    // Audit-log controls
    document.getElementById('btn-audit-refresh')?.addEventListener('click', loadAudit);

    // Search / filter / sort
    document.getElementById('proj-search')?.addEventListener('input', renderProjects);
    document.getElementById('proj-filter')?.addEventListener('change', renderProjects);
    document.getElementById('proj-sort')?.addEventListener('change', renderProjects);

    // Batch actions
    document.getElementById('batch-select-all')?.addEventListener('change', e=>{
        projSelected.clear();
        if(e.target.checked){
            document.querySelectorAll('.proj-check').forEach(cb=>{ projSelected.add(cb.dataset.id); cb.checked=true; cb.closest('.project-card')?.classList.add('selected'); });
        } else {
            document.querySelectorAll('.proj-check').forEach(cb=>{ cb.checked=false; cb.closest('.project-card')?.classList.remove('selected'); });
        }
        updateBatchBar();
    });
    document.getElementById('btn-batch-publish')?.addEventListener('click', batchPublish);
    document.getElementById('btn-batch-delete')?.addEventListener('click', batchDelete);
    document.getElementById('btn-fund-coverage')?.addEventListener('click', toggleFundCoverage);
    document.getElementById('fund-coverage-domain')?.addEventListener('change', renderFundCoverage);
    document.getElementById('btn-fund-save')?.addEventListener('click', saveFundMgmt);
    document.getElementById('btn-fund-add')?.addEventListener('click', addFund);
    document.getElementById('btn-alias-add')?.addEventListener('click', addAlias);
    document.getElementById('fund-mgmt-domain')?.addEventListener('change', renderFundMgmtList);
    document.getElementById('sup-mgmt-domain')?.addEventListener('change', renderSupMgmtList);
    document.getElementById('btn-sup-add')?.addEventListener('click', async () => {
        const domain = document.getElementById('sup-mgmt-domain').value;
        const code = document.getElementById('sup-mgmt-code').value.trim();
        const name = document.getElementById('sup-mgmt-name').value.trim();
        if (!code || !name) { toast('編號與名稱皆為必填', 1); return; }
        try {
            const r = await fetch('/api/admin/supervisors', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ domain, code, name })
            });
            if (!r.ok) throw new Error((await r.json()).detail || '儲存失敗');
            toast('已儲存');
            _supEditMode(false);
            loadSupervisorMgmt();
        } catch (e) { toast(e.message, 1); }
    });
    document.getElementById('btn-batch-clear')?.addEventListener('click', ()=>{
        projSelected.clear();
        document.querySelectorAll('.proj-check').forEach(cb=>{ cb.checked=false; cb.closest('.project-card')?.classList.remove('selected'); });
        updateBatchBar();
    });

    if (isCreateMode) {
        // Create mode: show upload area directly, hide admin overlay & listing items
        document.getElementById('project-upload-area').style.display = 'block';
        document.getElementById('project-list').style.display = 'none';
        document.getElementById('btn-new-project').style.display = 'none';
        
        // Update header/title to make it clear for the user
        const headerTitle = document.querySelector('.projects-header h2');
        if (headerTitle) headerTitle.textContent = '上傳 XLSX 並建立新專案';

        if (adminRequired) {
            checkAuthForCreation();
        } else {
            autoFillUploadEmail();
        }
    } else {
        if(adminRequired){
            checkAdminAuth();
        } else {
            updateAdminLayout();
            loadProjects();
        }
    }

    const uploadArea=document.getElementById('project-upload-area');
    const fileInput=document.getElementById('project-file-input');

    if (!isCreateMode) {
        document.getElementById('btn-new-project').addEventListener('click',()=>{
            const d=uploadArea.style.display;
            uploadArea.style.display=d==='none'?'block':'none';
        });
    }

    uploadArea.addEventListener('click',e=>{
        if(e.target.tagName==='INPUT'||e.target.tagName==='LABEL'||e.target.disabled)return;
        fileInput.click();
    });
    uploadArea.addEventListener('dragover',e=>{e.preventDefault();uploadArea.classList.add('drag-over')});
    uploadArea.addEventListener('dragleave',()=>uploadArea.classList.remove('drag-over'));
    uploadArea.addEventListener('drop',e=>{e.preventDefault();uploadArea.classList.remove('drag-over');const f=e.dataTransfer.files[0];if(f)projectUpload(f)});
    fileInput.addEventListener('change',e=>{if(e.target.files[0])projectUpload(e.target.files[0])});

    document.getElementById('app-title').addEventListener('click',()=>{location.href=getAdminToken()?'/':'/create'});
}

async function checkAuthForCreation() {
    try {
        const r = await fetch('/api/auth/verify', {
            headers: { 'X-Admin-Token': getAdminToken() }
        });
        const res = await r.json();
        if (res.admin_required && !res.authenticated) {
            document.getElementById('admin-overlay').style.display = 'flex';
        } else {
            if (res.authenticated) {
                sessionStorage.setItem('auth_role', res.role);
                if (res.email) {
                    sessionStorage.setItem('auth_email', res.email);
                } else {
                    sessionStorage.removeItem('auth_email');
                }
            }
            updateAdminLayout();
        }
    } catch(e) {
        document.getElementById('admin-overlay').style.display = 'flex';
    }
}

async function checkAdminAuth(){
    try{
        const r=await fetch('/api/auth/verify',{
            headers:{'X-Admin-Token':getAdminToken()}
        });
        const res=await r.json();
        if(res.admin_required && !res.authenticated){
            document.getElementById('admin-overlay').style.display='flex';
        } else {
            if (res.authenticated) {
                sessionStorage.setItem('auth_role', res.role);
                if (res.email) {
                    sessionStorage.setItem('auth_email', res.email);
                } else {
                    sessionStorage.removeItem('auth_email');
                }
            }
            updateAdminLayout();
            loadProjects();
        }
    }catch(e){
        document.getElementById('admin-overlay').style.display='flex';
    }
}

let allProjects=[];
const projSelected=new Set();

async function loadProjects(){
    try{
        const r=await fetch('/api/sessions',{headers:getAuthHeaders()});
        if(r.status===401){
            // Admin token expired or invalid
            document.getElementById('admin-overlay').style.display='flex';
            return;
        }
        const res=await r.json();
        allProjects=res.sessions||[];
        projSelected.clear();
        const tb=document.getElementById('projects-toolbar');
        if(tb) tb.style.display=allProjects.length?'flex':'none';
        const fcb=document.getElementById('fund-coverage-bar');
        if(fcb) fcb.style.display=allProjects.length?'flex':'none';
        renderProjects();
        updateBatchBar();
    }catch(e){toast(e.message,1)}
}

function renderProjects(){
    const list=document.getElementById('project-list');
    if(!list) return;
    if(!allProjects.length){
        list.innerHTML='<div class="empty-projects"><div class="icon">—</div><p>尚無專案，請上傳 Excel 檔案開始使用</p></div>';
        return;
    }
    const q=(document.getElementById('proj-search')?.value||'').trim().toLowerCase();
    const filter=document.getElementById('proj-filter')?.value||'all';
    const sort=document.getElementById('proj-sort')?.value||'updated';

    let rows=allProjects.filter(p=>{
        if(q && !String(p.name||'').toLowerCase().includes(q)) return false;
        if(filter==='published' && !p.published) return false;
        if(filter==='unpublished' && p.published) return false;
        return true;
    });
    rows.sort((a,b)=>{
        if(sort==='name') return String(a.name||'').localeCompare(String(b.name||''),'zh-Hant');
        if(sort==='created') return String(b.created_at||'').localeCompare(String(a.created_at||''));
        if(sort==='responses') return (b.response_count||0)-(a.response_count||0);
        return String(b.updated_at||'').localeCompare(String(a.updated_at||'')); // updated (default)
    });

    if(!rows.length){
        list.innerHTML='<div class="empty-projects filtered"><div class="icon">🔍</div><p>沒有符合條件的專案</p></div>';
        return;
    }

    const ro=isReadOnly();
    let h='<div class="project-grid">';
    for(const p of rows){
        const badge=p.published
            ? `<span class="badge published">已發布 (${p.response_count||0})</span>`
            : '<span class="badge unpublished">未發布</span>';
        const viewRespBtn = p.published
            ? `<button class="btn btn-success" onclick="location.href='/editor/${p.id}#responses'" style="font-size:var(--fs-sm)">彙整</button>`
            : '';
        const copyBtn = p.published
            ? `<button class="icon-btn" onclick="copyShareLink('${p.share_token}')" title="複製分享連結" style="font-size:var(--fs-sm)">&#128279;</button>`
            : '';
        const updated = (p.updated_at||p.created_at||'').replace('T',' ').slice(0,16);
        const checked = projSelected.has(p.id)?'checked':'';
        h+=`<div class="project-card${checked?' selected':''}" data-id="${p.id}">
            <div class="check"><input type="checkbox" class="proj-check" data-id="${p.id}" ${checked}></div>
            <div class="info">
                <div class="name">${escapeHtml(p.name)}</div>
                <div class="meta">
                    <span>${p.row_count||0} 列 &times; ${p.col_count||0} 欄</span>
                    ${p.published?`<span class="resp">${p.response_count||0} 筆回應</span>`:''}
                    <span class="updated">${updated}</span>
                    ${badge}
                </div>
            </div>
            <div class="actions">
                ${copyBtn}
                ${viewRespBtn}
                ${ro ? '' : `<button class="icon-btn" onclick="saveAsTemplate('${p.id}')" title="存為範本" style="font-size:var(--fs-sm)">T</button>`}
                <button class="btn btn-primary" onclick="location.href='/editor/${p.id}'" style="font-size:var(--fs-sm)">${ro ? '檢視' : '編輯'}</button>
                ${ro ? '' : `<button class="icon-btn danger" onclick="deleteProject('${p.id}')" title="刪除">&times;</button>`}
            </div>
        </div>`;
    }
    h+='</div>';
    list.innerHTML=h;

    list.querySelectorAll('.proj-check').forEach(cb=>{
        cb.addEventListener('change',()=>{
            const id=cb.dataset.id;
            if(cb.checked) projSelected.add(id); else projSelected.delete(id);
            cb.closest('.project-card')?.classList.toggle('selected',cb.checked);
            updateBatchBar();
        });
    });
}

function copyShareLink(token){
    const url=location.origin+'/fill/'+token;
    navigator.clipboard?.writeText(url).then(
        ()=>toast('已複製分享連結'),
        ()=>{prompt('複製此連結：',url)}
    );
}
window.copyShareLink=copyShareLink;

function updateBatchBar(){
    const bar=document.getElementById('batch-bar');
    const count=document.getElementById('batch-count');
    const all=document.getElementById('batch-select-all');
    if(!bar) return;
    const n=projSelected.size;
    bar.classList.toggle('show',n>0);
    if(count) count.textContent=`已選 ${n} 項`;
    if(all){
        const visible=document.querySelectorAll('.proj-check').length;
        all.checked = n>0 && n===visible;
    }
}

let fundCoverageData = null;

async function toggleFundCoverage(){
    const domSel = document.getElementById('fund-coverage-domain');
    const panel = document.getElementById('fund-coverage-panel');
    if(domSel.style.display !== 'none'){
        domSel.style.display='none';
        panel.style.display='none';
        fundCoverageData=null;
        return;
    }
    try{
        toast('載入基金覆蓋率⋯');
        const r = await fetch('/api/fund-coverage',{headers:getAuthHeaders()});
        if(!r.ok) throw new Error('載入失敗');
        fundCoverageData = await r.json();
        domSel.innerHTML='<option value="">-- 選擇基金類型 --</option>';
        for(const [dom, dd] of Object.entries(fundCoverageData)){
            domSel.innerHTML+=`<option value="${dom}">${escapeHtml(dd.label)}（${dd.covered}/${dd.total}）</option>`;
        }
        domSel.style.display='';
        panel.style.display='none';
    }catch(e){toast(e.message,1)}
}

function _coverageTag(f, isSub) {
    const prefix = isSub ? '<span style="color:var(--text-muted);margin-right:2px">└</span>' : '';
    if (f.uploaded) {
        return `<span class="tag-green">${prefix}${escapeHtml(f.name)}</span>`;
    }
    return `<span class="tag-red">${prefix}${escapeHtml(f.name)}</span>`;
}

function renderFundCoverage(){
    const dom = document.getElementById('fund-coverage-domain').value;
    const panel = document.getElementById('fund-coverage-panel');
    const content = document.getElementById('fund-coverage-content');
    if(!dom || !fundCoverageData || !fundCoverageData[dom]){
        panel.style.display='none';
        return;
    }
    const dd = fundCoverageData[dom];
    let h=`<div class="mb-3" style="font-size:14px;color:var(--text-strong)">
        <strong>${escapeHtml(dd.label)}</strong>
        — 已繳交 <span style="color:var(--success);font-weight:600">${dd.covered}</span>/${dd.total}
        ，未繳交 <span style="color:var(--danger);font-weight:600">${dd.total - dd.covered}</span>
    </div>`;
    // Flatten for grouping
    const allFlat = [];
    for (const f of dd.funds) {
        allFlat.push({ name: f.name, uploaded: f.uploaded, isSub: false });
        if (f.children) {
            for (const c of f.children) {
                allFlat.push({ name: c.name, uploaded: c.uploaded, isSub: true });
            }
        }
    }
    const missing = allFlat.filter(f=>!f.uploaded);
    const uploaded = allFlat.filter(f=>f.uploaded);
    if(missing.length){
        h+=`<div class="mb-3"><div style="font-size:13px;font-weight:600;color:var(--danger);margin-bottom:6px">❌ 未繳交（${missing.length}）</div>`;
        h+=`<div class="flex flex-wrap" style="gap:4px">`;
        for(const f of missing) h+=_coverageTag(f, f.isSub);
        h+=`</div></div>`;
    }
    if(uploaded.length){
        h+=`<div><div class="fw-7" style="font-size:var(--fs-base);color:var(--success);margin-bottom:8px">已繳交（${uploaded.length}）</div>`;
        h+=`<div class="flex flex-wrap" style="gap:4px">`;
        for(const f of uploaded) h+=_coverageTag(f, f.isSub);
        h+=`</div></div>`;
    }
    content.innerHTML=h;
    panel.style.display='block';
}

async function batchPublish(){
    if(!projSelected.size) return;
    const ids=[...projSelected];
    if(!confirm(`確定發布所選的 ${ids.length} 個專案？`)) return;
    let ok=0;
    for(const id of ids){
        try{
            const r=await fetch(`/api/sessions/${id}/publish`,{method:'POST',headers:projHeaders(id)});
            if(r.ok) ok++;
        }catch(e){}
    }
    toast(`已發布 ${ok}/${ids.length} 個專案`);
    loadProjects();
}

async function batchDelete(){
    if(!projSelected.size) return;
    const ids=[...projSelected];
    if(!confirm(`確定刪除所選的 ${ids.length} 個專案？此動作無法復原。`)) return;
    let ok=0;
    for(const id of ids){
        try{
            const r=await fetch(`/api/sessions/${id}`,{method:'DELETE',headers:projHeaders(id)});
            if(r.ok) ok++;
        }catch(e){}
    }
    toast(`已刪除 ${ok}/${ids.length} 個專案`);
    loadProjects();
}

// Build headers for per-project actions: admin token bypasses password;
// otherwise fall back to the password cached when the project was created.
function projHeaders(id){
    const h={};
    const tk=getAdminToken();
    if(tk) h['X-Admin-Token']=tk;
    const pwd=sessionStorage.getItem('project_password_'+id);
    if(pwd) h['X-Project-Password']=pwd;
    return h;
}

async function deleteProject(id){
    const isAdmin = sessionStorage.getItem('auth_role')==='admin' || (!adminRequired);
    let headers;
    if(isAdmin){
        if(!confirm('確定刪除此專案？此動作無法復原。')) return;
        headers = projHeaders(id);
    } else {
        const password = prompt('請輸入此專案的編輯密碼以確認刪除：');
        if(password === null) return;
        if(!password.trim()){
            toast('必須輸入密碼才能刪除專案', 1);
            return;
        }
        headers = { 'X-Project-Password': password.trim() };
    }
    try{
        const r=await fetch(`/api/sessions/${id}`,{
            method:'DELETE',
            headers
        });
        if(r.ok){
            toast('已刪除');
            loadProjects();
        } else {
            const res = await r.json();
            throw new Error(res.detail || '刪除失敗');
        }
    }catch(e){toast(e.message,1)}
}

async function projectUpload(file){
    if(!file.name.match(/\.xlsx?$/i)){toast('請選擇 .xlsx 檔案',1);return}
    const email=document.getElementById('project-email').value.trim();
    const password=document.getElementById('project-password').value.trim();
    if(!email||!password){
        toast('請先輸入 Email 與專案編輯密碼！',1);
        return;
    }
    const customName = (document.getElementById('project-name-input')?.value || '').trim();
    const loading=document.getElementById('project-upload-loading');
    const area=document.getElementById('project-upload-area');
    loading.style.display='block';area.style.display='none';
    const fd=new FormData();
    fd.append('file',file);
    fd.append('email',email);
    fd.append('password',password);
    if(customName) {
        fd.append('name',customName);
    }
    try{
        const headers={};
        const adminTk=getAdminToken();
        if(adminTk) headers['X-Admin-Token']=adminTk;
        const r=await fetch('/api/upload-xlsx',{method:'POST',headers,body:fd});const res=await r.json();
        if(!r.ok)throw new Error(res.detail||'失敗');
        // 保存編輯密碼在 sessionStorage，進入編輯器時能一鍵免密碼解鎖
        sessionStorage.setItem('project_password_'+res.session_id,password);
        location.href=`/editor/${res.session_id}`;
    }catch(e){toast(e.message,1);loading.style.display='none';area.style.display='block'}
}

// ===== Editor Mode =====
function initEditorWithSession(sid){
    sessionId=sid;
    const backLink = document.getElementById('back-link');
    if (backLink) {
        backLink.style.display = 'inline';
        backLink.href = getAdminToken() ? '/' : '/create';
        if (!getAdminToken()) {
            backLink.textContent = '← 建立新專案';
        }
    }
    loadEditorSession();
}

async function loadEditorSession(){
    const editor=document.getElementById('editor');
    const tableContainer=document.getElementById('table-container');
    const fileName=document.getElementById('file-name');
    try{
        const r=await fetch(`/api/sessions/${sessionId}`, {
            headers: getAuthHeaders()
        });
        if(r.status===401||r.status===403){
            document.getElementById('password-overlay').style.display='flex';
            if(r.status===403){
                toast('密碼錯誤，請重新輸入！',1);
            }
            return;
        }
        const res=await r.json();
        if(!r.ok)throw new Error(res.detail||'載入失敗');
        document.getElementById('password-overlay').style.display='none';
        data=res.current_data||res.json||[];
        original=JSON.parse(JSON.stringify(data));
        fileName.textContent=res.name||'';
        document.getElementById('app-title').textContent=res.name?.replace(/\.xlsx?$/i,'')||'預算表單編輯系統';
        
        const editorProjName = document.getElementById('editor-project-name');
        if (editorProjName) {
            editorProjName.value = res.name || '';
        }
        
        recalcAll();render();
        populateFundColSelect(res.fund_col || 0);
        editor.style.display='block';
        if(window.location.hash==='#responses'){
            const respTab=document.querySelector('.tab-bar .tab[data-tab="responses"]');
            if(respTab)respTab.click();
        }
    }catch(e){toast(e.message,1);editor.innerHTML=`<p style="padding:40px;color:#dc2626;text-align:center">${escapeHtml(e.message)}</p>`;editor.style.display='block'}
}

function populateFundColSelect(selected){
    const sel=document.getElementById('editor-fund-col');
    if(!sel)return;
    const hdrs=getHeaders();
    const maxC=Math.max(...data.map(r=>r.length||0),1);
    let h='';
    for(let c=0;c<maxC;c++){
        const label=hdrs[c]?`${alpha(c)}：${escapeHtml(hdrs[c])}`:`欄${alpha(c)}`;
        h+=`<option value="${c}"${c===Number(selected)?' selected':''}>${label}</option>`;
    }
    sel.innerHTML=h;
}

function isMergeSel(r,c){
    if(!selectionStart||!selectionEnd) return false;
    const r0=Math.min(selectionStart.r,selectionEnd.r),r1=Math.max(selectionStart.r,selectionEnd.r);
    const c0=Math.min(selectionStart.c,selectionEnd.c),c1=Math.max(selectionStart.c,selectionEnd.c);
    return r>=r0&&r<=r1&&c>=c0&&c<=c1;
}

function hasMergedCells(d){
    return d.some(row=>row&&row.some(c=>c&&((c.rowspan||1)>1||(c.colspan||1)>1)));
}

function render(){
    const tableContainer=document.getElementById('table-container');
    if(!data.length){tableContainer.innerHTML='';return}
    const maxC=Math.max(...data.map(r=>r.length||0),1);const hdrs=getHeaders();const nums=getNumerics();
    let h='<table id="main-table"><thead><tr>';
    if(editMode) h+='<th class="chk-col"></th>';
    for(let c=0;c<maxC;c++){
        const colChk=editMode?`<input type="checkbox" class="col-chk" data-col="${c}"${checkedCols.has(c)?' checked':''}> `:'';
        h+=`<th>${colChk}<input type="text" id="hdr-${c}" name="hdr-${c}" data-row="0" data-col="${c}" value="${escapeHtml(hdrs[c]||'')}" placeholder="欄${alpha(c)}"></th>`;
    }
    h+='</tr></thead><tbody>';
    for(let r=1;r<data.length;r++){
        const row=data[r]||[];const name=row[0]?.value||'';const lv=detectLevel(name);
        h+=`<tr class="lv-${lv}">`;
        if(editMode) h+=`<td class="chk-col"><input type="checkbox" class="row-chk" data-row="${r}"${checkedRows.has(r)?' checked':''}></td>`;
        for(let c=0;c<Math.max(maxC,row.length);c++){
            const cell=row[c]||{value:'',_autoSum:false,_formula:''};
            if(cell._skip) continue;
            const val=cell.value||'';
            const isNum=nums.includes(c);const isAuto=cell._autoSum;const hasF=cell._formula&&!cell._autoSum;
            const cls=`${isNum?'num':'txt'}${isAuto?' auto-sum':''}${hasF?' formula-cell':''}`;
            const spanAttr=(cell.rowspan>1?` rowspan="${cell.rowspan}"`:'')+(cell.colspan>1?` colspan="${cell.colspan}"`:'');
            const selCls=isMergeSel(r,c)?'merge-sel':'';
            const isMerged=(cell.rowspan>1||cell.colspan>1);
            const tdCls=[hasF?'formula':'',selCls,isMerged?'merged-cell':''].filter(Boolean).join(' ');
            h+=`<td${tdCls?` class="${tdCls}"`:''}${spanAttr}>`;
            h+=`<input type="text" class="${cls}" name="r${r}_c${c}" data-r="${r}" data-c="${c}" value="${escapeHtml(val)}" placeholder="${c===0?'名稱':(isNum?'0':'')}">`;
            h+='</td>';
        }
        h+='</tr>';
    }
    h+='</tbody></table>';
    const warn=hasMergedCells(data)?'<div class="merge-warn">⚠ 此表單含合併儲存格（黃底粗框處）。填寫者匯入 Excel 時，合併區域只會保留左上格的值、其餘格將為空白，請確認此版面適合作為填寫表單。</div>':'';
    tableContainer.innerHTML=warn+h;
    document.querySelectorAll('#main-table input[data-r]').forEach(inp=>{
        inp.addEventListener('change',onChange);inp.addEventListener('focus',onFocus);
        inp.addEventListener('blur',onBlur);inp.addEventListener('paste',onPaste);inp.addEventListener('keydown',onKeyDown);
        inp.addEventListener('mousedown',onCellMouseDown);
    });
    document.querySelectorAll('#main-table .row-chk').forEach(chk=>{
        chk.addEventListener('change',()=>{
            const r=parseInt(chk.dataset.row);
            chk.checked?checkedRows.add(r):checkedRows.delete(r);
            updateBatchCount();
        });
    });
    document.querySelectorAll('#main-table .col-chk').forEach(chk=>{
        chk.addEventListener('change',()=>{
            const c=parseInt(chk.dataset.col);
            chk.checked?checkedCols.add(c):checkedCols.delete(c);
        });
    });
    updateFormulaCols();
    updateMergeButtons();
}

function updateBatchCount(){
    const el=document.getElementById('batch-edit-count');
    if(el) el.textContent=`已選 ${checkedRows.size} 列`;
}

function onCellMouseDown(e){
    if(!e.shiftKey){
        selectionStart={r:parseInt(e.target.dataset.r),c:parseInt(e.target.dataset.c)};
        selectionEnd=null;
    } else if(selectionStart){
        selectionEnd={r:parseInt(e.target.dataset.r),c:parseInt(e.target.dataset.c)};
        render();
    }
    updateMergeButtons();
}

function updateMergeButtons(){
    const mergeBtn=document.getElementById('btn-merge');
    const unmergeBtn=document.getElementById('btn-unmerge');
    if(!mergeBtn) return;
    const hasSel=selectionStart&&selectionEnd&&(selectionStart.r!==selectionEnd.r||selectionStart.c!==selectionEnd.c);
    mergeBtn.style.display=hasSel?'':'none';
    const cell=selectedCell&&data[selectedCell.r]?.[selectedCell.c];
    unmergeBtn.style.display=(cell&&(cell.rowspan>1||cell.colspan>1))?'':'none';
}

function doMerge(){
    if(!selectionStart||!selectionEnd) return;
    pushUndo();
    const r0=Math.min(selectionStart.r,selectionEnd.r),r1=Math.max(selectionStart.r,selectionEnd.r);
    const c0=Math.min(selectionStart.c,selectionEnd.c),c1=Math.max(selectionStart.c,selectionEnd.c);
    const topLeft=data[r0]?.[c0];
    if(!topLeft) return;
    topLeft.rowspan=(r1-r0+1);
    topLeft.colspan=(c1-c0+1);
    for(let r=r0;r<=r1;r++){
        for(let c=c0;c<=c1;c++){
            if(r===r0&&c===c0) continue;
            if(!data[r]) data[r]=[];
            data[r][c]={_skip:true,value:''};
        }
    }
    selectionStart=selectionEnd=null;
    isDirty=true;render();toast('已合併儲存格');
}

function doUnmerge(){
    if(!selectedCell) return;
    const cell=data[selectedCell.r]?.[selectedCell.c];
    if(!cell||(!cell.rowspan&&!cell.colspan)) return;
    pushUndo();
    const rs=cell.rowspan||1,cs=cell.colspan||1;
    delete cell.rowspan;delete cell.colspan;
    for(let r=selectedCell.r;r<selectedCell.r+rs;r++){
        for(let c=selectedCell.c;c<selectedCell.c+cs;c++){
            if(r===selectedCell.r&&c===selectedCell.c) continue;
            if(data[r]?.[c]) {delete data[r][c]._skip; data[r][c].value='';}
        }
    }
    isDirty=true;render();toast('已取消合併');
}

let _undoPushedForFocus=false;
function onChange(e){
    const inp=e.target;const r=parseInt(inp.dataset.r),c=parseInt(inp.dataset.c);
    const val=inp.value.trim();while(data.length<=r)data.push([]);if(!data[r])data[r]=[];
    if(!data[r][c])data[r][c]={row:r+1,col:c+1,value:'',type:'str'};
    if(data[r][c].value!==val){
        if(!_undoPushedForFocus){pushUndo();_undoPushedForFocus=true;}
        data[r][c].value=val;
        // Manually editing a cell overrides any formula/auto-sum on it
        if(data[r][c]._formula)data[r][c]._formula='';
        if(data[r][c]._autoSum)data[r][c]._autoSum=false;
        isDirty=true;
    }
    refreshComputed(r,c);
}

// Recompute the model, then push computed values into existing inputs in place —
// preserves focus and Tab/Enter navigation (no full re-render).
function refreshComputed(skipR,skipC){
    recalcAll();
    const tbl=document.getElementById('main-table');if(!tbl)return;
    const nums=getNumerics();
    tbl.querySelectorAll('input[data-r]').forEach(inp=>{
        const r=parseInt(inp.dataset.r),c=parseInt(inp.dataset.c);
        if((r===skipR&&c===skipC)||inp===document.activeElement)return;
        const cell=data[r]?.[c];if(!cell)return;
        const isAuto=!!cell._autoSum,hasF=!!cell._formula&&!cell._autoSum;
        if(!isAuto&&!hasF)return;                          // only update computed cells
        inp.value=(c>0&&nums.includes(c))?fmtNum(parseNum(cell.value)):(cell.value||'');
        inp.className=`${nums.includes(c)?'num':'txt'}${isAuto?' auto-sum':''}${hasF?' formula-cell':''}`;
        const td=inp.closest('td');if(td)td.className=hasF?'formula':'';
    });
}

function onFocus(e){
    _undoPushedForFocus=false;
    const inp=e.target;selectedCell={r:parseInt(inp.dataset.r),c:parseInt(inp.dataset.c)};
    document.querySelectorAll('td.focused').forEach(t=>t.classList.remove('focused'));const td=inp.closest('td');if(td)td.classList.add('focused');inp.select();
    const cell=data[selectedCell.r]?.[selectedCell.c];const colSelect=document.getElementById('formula-col');colSelect.value=selectedCell.c;
    document.getElementById('formula-input').value=cell?._formula||'';
}

function onBlur(e){
    const inp=e.target;const r=parseInt(inp.dataset.r),c=parseInt(inp.dataset.c);
    if(c>0){const n=parseNum(inp.value);if(n!==null)inp.value=fmtNum(n)}
}

function onKeyDown(e){
    const inp=e.target;const r=parseInt(inp.dataset.r),c=parseInt(inp.dataset.c);
    const tr=inp.closest('tr');const tbody=tr.parentElement;const rows=Array.from(tbody.querySelectorAll('tr'));const cells=Array.from(tr.querySelectorAll('td'));
    const idx=rows.indexOf(tr);const ci=cells.indexOf(inp.closest('td'));
    if(e.key==='Tab'){e.preventDefault();const dir=e.shiftKey?-1:1;const next=ci+dir;const td=next>=0&&next<cells.length?cells[next]:(dir>0?cells[0]:cells[cells.length-1]);const input=td?.querySelector('input');if(input)input.focus()}
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const nextTr=rows[idx+1];if(nextTr){const nextCells=nextTr.querySelectorAll('td');const td=nextCells[ci]||nextCells[0];const input=td?.querySelector('input');if(input)input.focus()}}
    if(e.key==='Escape'){inp.blur()}
}

function onPaste(e){
    e.preventDefault();pushUndo();const inp=e.target;const r=parseInt(inp.dataset.r),c=parseInt(inp.dataset.c);
    const text=(e.clipboardData||window.clipboardData).getData('text');if(!text)return;
    const rows=text.split(/\r?\n/).filter(r=>r.trim());if(!rows.length)return;const cells=rows.map(r=>r.split('\t'));
    cells.forEach((rowData,ri)=>{const targetR=r+ri;while(data.length<=targetR)data.push([]);if(!data[targetR])data[targetR]=[];rowData.forEach((val,ci)=>{const targetC=c+ci;if(!data[targetR][targetC])data[targetR][targetC]={row:targetR+1,col:targetC+1,value:'',type:'str'};data[targetR][targetC].value=val.trim()})});
    isDirty=true;recalcAll();render();
    const newInput=document.querySelector(`input[data-r="${r}"][data-c="${c}"]`);if(newInput)newInput.focus();
    toast(`已貼上 ${cells.length} 列`);
}

function updateFormulaCols(){
    const sel=document.getElementById('formula-col');sel.innerHTML='<option value="">— 選擇欄位 —</option>';const hdrs=getHeaders();
    for(let c=1;c<Math.max(...data.map(r=>r.length),2);c++){const opt=document.createElement('option');opt.value=c;opt.textContent=`${alpha(c)}：${hdrs[c]||'欄'+alpha(c)}`;sel.appendChild(opt)}
}

// ===== Editor Event Binds (run once) =====
(function bindEditorEvents(){
    document.getElementById('btn-save').addEventListener('click',async()=>{
        if(!sessionId)return;
        try{
            const updatedName = (document.getElementById('editor-project-name')?.value || '').trim();
            const fundColEl = document.getElementById('editor-fund-col');
            const fundCol = fundColEl ? Number(fundColEl.value) : null;
            const r=await fetch(`/api/sessions/${sessionId}/save`,{
                method:'POST',
                headers:{'Content-Type':'application/json', ...getAuthHeaders()},
                body:JSON.stringify({session_id:sessionId,data,name:updatedName,fund_col:fundCol})
            });
            if(r.ok){
                isDirty=false;
                if(updatedName) {
                    document.getElementById('file-name').textContent = updatedName;
                    document.getElementById('app-title').textContent = updatedName.replace(/\.xlsx?$/i, '');
                }
                toast('已儲存');
            } else throw new Error('失敗');
        }catch(e){toast(e.message,1)}
    });
    document.getElementById('btn-export').addEventListener('click',()=>{if(!sessionId)return;window.open(`/api/sessions/${sessionId}/export/json`,'_blank')});
    document.getElementById('btn-export-xlsx').addEventListener('click',async()=>{
        if(!sessionId)return;
        const name = (document.getElementById('file-name').textContent || 'project').trim();
        const now = new Date();
        const timeStr = now.getFullYear() +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0') + '_' +
            String(now.getHours()).padStart(2, '0') +
            String(now.getMinutes()).padStart(2, '0') +
            String(now.getSeconds()).padStart(2, '0');
        const filename = `${name.replace(/\.xlsx?$/i, '')}_${timeStr}.xlsx`;
        toast('正在匯出 XLSX 檔案⋯');
        await downloadXlsxFile(name, data, filename);
        toast('匯出 XLSX 成功');
    });
    document.getElementById('btn-import').addEventListener('click',()=>document.getElementById('json-import').click());
    document.getElementById('json-import').addEventListener('change',async e=>{const file=e.target.files[0];if(!file||!sessionId)return;const fd=new FormData();fd.append('file',file);try{const r=await fetch(`/api/sessions/${sessionId}/import/json`,{method:'POST',headers:getAuthHeaders(),body:fd});if(r.ok){toast('匯入成功');const s=await fetch(`/api/sessions/${sessionId}`,{headers:getAuthHeaders()}).then(r=>r.json());data=s.current_data||s.json||[];original=JSON.parse(JSON.stringify(data));recalcAll();render()}}catch(e){toast(e.message,1)}});
    document.getElementById('btn-add-row').addEventListener('click',()=>{pushUndo();const maxC=Math.max(...data.map(r=>r.length),2);const nr=[];for(let c=0;c<maxC;c++)nr.push({row:data.length+1,col:c+1,value:'',type:'str'});data.push(nr);recalcAll();render();isDirty=true;toast('新增一列')});
    document.getElementById('btn-add-col').addEventListener('click',()=>{pushUndo();data.forEach(row=>{row.push({row:0,col:row.length+1,value:'',type:'str'})});recalcAll();render();isDirty=true;toast('新增一欄')});
    document.getElementById('btn-reset').addEventListener('click',()=>{if(!data.length)return;if(!confirm('重新載入原始欄位資料？'))return;pushUndo();data=JSON.parse(JSON.stringify(original));recalcAll();render();isDirty=false;toast('已重新載入')});
    document.getElementById('btn-clear').addEventListener('click',()=>{if(!data.length)return;if(!confirm('清除所有欄位名稱？保留結構與公式'))return;pushUndo();data.forEach(row=>row.forEach(c=>{if(c){c.value='';c._autoSum=undefined}}));recalcAll();render();isDirty=true;toast('已清除欄位名稱')});
    document.getElementById('btn-undo').addEventListener('click',undo);
    document.getElementById('btn-merge').addEventListener('click',doMerge);
    document.getElementById('btn-unmerge').addEventListener('click',doUnmerge);
    document.getElementById('btn-edit-mode').addEventListener('click',()=>{
        editMode=!editMode;checkedRows.clear();checkedCols.clear();
        document.getElementById('btn-edit-mode').classList.toggle('active',editMode);
        document.getElementById('batch-edit-bar').style.display=editMode?'flex':'none';
        updateBatchCount();render();
    });
    document.getElementById('batch-select-all-editor').addEventListener('change',e=>{
        checkedRows.clear();
        if(e.target.checked) for(let r=1;r<data.length;r++) checkedRows.add(r);
        updateBatchCount();render();
    });
    document.getElementById('btn-batch-del-rows').addEventListener('click',()=>{
        if(!checkedRows.size){toast('請先勾選要刪除的列',1);return}
        if(!confirm(`刪除 ${checkedRows.size} 列？`))return;
        pushUndo();
        const sorted=[...checkedRows].sort((a,b)=>b-a);
        sorted.forEach(r=>{if(r>0&&r<data.length) data.splice(r,1)});
        checkedRows.clear();updateBatchCount();recalcAll();render();isDirty=true;toast('已刪除');
    });
    document.getElementById('btn-batch-del-cols').addEventListener('click',()=>{
        if(!checkedCols.size){toast('請先勾選表頭的欄位核取方塊',1);return}
        if(!confirm(`刪除 ${checkedCols.size} 欄？`))return;
        pushUndo();
        const sorted=[...checkedCols].sort((a,b)=>b-a);
        data.forEach(row=>{sorted.forEach(c=>{if(c<row.length) row.splice(c,1)})});
        checkedCols.clear();recalcAll();render();isDirty=true;toast('已刪除');
    });
    document.addEventListener('keydown',e=>{
        if((e.ctrlKey||e.metaKey)&&e.key==='z'&&!e.shiftKey){e.preventDefault();undo()}
    });
    document.getElementById('btn-new-upload').addEventListener('click',()=>{if(isDirty&&!confirm('有未儲存變更，離開？'))return;location.href=getAdminToken()?'/':'/create'});
    document.getElementById('btn-apply-formula').addEventListener('click',()=>{
        const col=parseInt(document.getElementById('formula-col').value);
        const formula=document.getElementById('formula-input').value.trim();
        if(isNaN(col)||!formula){toast('請選擇欄位並輸入公式',1);return}
        if(!formula.startsWith('=')){toast('公式需以 = 開頭，例如 =B+C',1);return}
        pushUndo();applyFormula(col,formula);recalcAll();render();toast('公式已套用至整欄');
    });
    document.getElementById('btn-apply-cell').addEventListener('click',()=>{
        const formula=document.getElementById('formula-input').value.trim();
        if(!selectedCell){toast('請先點選要套用的儲存格',1);return}
        if(selectedCell.c===0){toast('名稱欄不支援公式',1);return}
        if(!formula){toast('請輸入公式',1);return}
        if(!formula.startsWith('=')){toast('公式需以 = 開頭，例如 =B2*1.05',1);return}
        pushUndo();applyFormula(selectedCell.c,formula,selectedCell.r);recalcAll();render();toast('公式已套用至此格');
    });
    document.getElementById('formula-input').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-apply-formula').click()});
    document.getElementById('app-title').addEventListener('click',()=>{if(isDirty&&!confirm('有未儲存變更，離開？'))return;location.href=getAdminToken()?'/':'/create'});

    // Publish
    document.getElementById('btn-publish').addEventListener('click',async()=>{
        if(!sessionId){toast('請先上傳檔案',1);return}
        document.getElementById('publish-step1').style.display='block';
        document.getElementById('publish-step2').style.display='none';
        document.getElementById('publish-title').textContent='發布表單';
        document.getElementById('publish-dialog').classList.add('show');
        try{
            const r=await fetch(`/api/sessions/${sessionId}/publish`,{headers:getAuthHeaders()});
            const res=await r.json();
            if(res.published!==false){
                document.getElementById('publish-step1').style.display='none';
                document.getElementById('publish-step2').style.display='block';
                document.getElementById('share-url-input').value=`${window.location.origin}/fill/${res.share_token}`;
                document.getElementById('publish-stats').textContent=`已有 ${res.response_count} 筆回應`;
            }
        }catch(e){}
    });

    document.getElementById('btn-publish-generate').addEventListener('click',async()=>{
        if(!sessionId)return;
        try{
            const r=await fetch(`/api/sessions/${sessionId}/publish`,{method:'POST',headers:getAuthHeaders()});const res=await r.json();
            if(!r.ok)throw new Error(res.detail||'發布失敗');
            document.getElementById('publish-step1').style.display='none';
            document.getElementById('publish-step2').style.display='block';
            document.getElementById('share-url-input').value=`${window.location.origin}${res.fill_url}`;
            document.getElementById('publish-stats').textContent=`已有 ${res.response_count} 筆回應`;
            toast('已發布');
        }catch(e){toast(e.message,1)}
    });

    document.getElementById('close-publish').addEventListener('click',()=>document.getElementById('publish-dialog').classList.remove('show'));
    document.getElementById('publish-dialog').addEventListener('click',e=>{if(e.target===e.currentTarget)document.getElementById('publish-dialog').classList.remove('show')});
    document.getElementById('btn-copy-url').addEventListener('click',()=>{
        const inp=document.getElementById('share-url-input');inp.select();navigator.clipboard?.writeText(inp.value);
        toast('已複製連結');
    });
    document.getElementById('btn-unpublish').addEventListener('click',async()=>{
        if(!sessionId)return;if(!confirm('取消發布後，現有分享連結將失效。確定？'))return;
        try{const r=await fetch(`/api/sessions/${sessionId}/publish`,{method:'DELETE',headers:getAuthHeaders()});if(r.ok){document.getElementById('publish-dialog').classList.remove('show');loadProjects();toast('已取消發布')}}catch(e){toast(e.message,1)}
    });

    // Tab switching
    document.querySelectorAll('.tab-bar .tab').forEach(tab=>{
        tab.addEventListener('click',()=>{
            document.querySelectorAll('.tab-bar .tab').forEach(t=>t.classList.remove('active'));
            tab.classList.add('active');
            const show=tab.dataset.tab;
            document.getElementById('editor-tab').style.display=show==='edit'?'block':'none';
            document.getElementById('responses-tab').style.display=show==='responses'?'block':'none';
            if(show==='responses')loadResponses();
        });
    });

    // Load responses — uses ?full=true to avoid N+1 HTTP queries
    async function loadResponses(){
        if(!sessionId){document.getElementById('responses-container').innerHTML='<p style="padding:24px;color:#94a3b8;text-align:center">請先上傳檔案</p>';return}
        document.getElementById('responses-container').innerHTML='<p style="padding:24px;color:#94a3b8;text-align:center">載入中⋯</p>';
        try{
            const r=await fetch(`/api/sessions/${sessionId}/responses?full=true`,{headers:getAuthHeaders()});const res=await r.json();
            const container=document.getElementById('responses-container');
            document.getElementById('resp-stats').textContent=res.count?`共 ${res.count} 筆回應`:'尚無回應';
            if(!res.responses||!res.responses.length){
                container.innerHTML='<p style="padding:48px;color:var(--text-muted);text-align:center">尚無回應<br><span style="font-size:var(--fs-sm)">發布表單後，填表人提交的資料會顯示在這裡</span></p>';
                return;
            }
            const headers=(data[0]||[]).map(c=>c.value||'');
            const fulls=res.responses;
            const maxC=Math.max(...fulls.map(f=>{const d=f.data||[];return Math.max(...d.map(r=>r.length||0),1)}),1);
            let h='<table class="resp-compare-table"><thead><tr><th style="min-width:30px">#</th><th>填表人</th><th>時間</th>';
            for(let c=0;c<maxC;c++){h+=`<th>${escapeHtml(headers[c]||'')}</th>`}
            h+='<th></th></tr></thead><tbody>';
            fulls.forEach((full,idx)=>{
                const resp=full;const rowData=resp.data||[];
                const dataRows=rowData.slice(1);
                if(!dataRows.length)return;
                const rowSpan=dataRows.length;
                const modifiedBadge=resp.modified
                    ? `<span class="badge" style="background:#fef3c7;color:#d97706;margin-left:4px;font-size:10px;padding:1px 4px" title="修改時間：${resp.modified_at}">⚠️ 已修正</span>`
                    : '';
                const emailLabel=resp.email
                    ? `<br><span style="font-size:11px;color:#94a3b8">${escapeHtml(resp.email)}</span>`
                    : '';
                dataRows.forEach((row,ri)=>{
                    h+=`<tr>`;
                    if(ri===0){
                        h+=`<td style="text-align:center;color:#94a3b8" rowspan="${rowSpan}">${idx+1}</td>`;
                        h+=`<td rowspan="${rowSpan}"><strong>${escapeHtml(resp.respondent||'匿名')}</strong>${modifiedBadge}${emailLabel}</td>`;
                        h+=`<td class="resp-row-label" rowspan="${rowSpan}">${resp.submitted_at}</td>`;
                    }
                    for(let c=0;c<maxC;c++){
                        const cell=row[c]||{};
                        h+=`<td>${escapeHtml(cell.value||'')}</td>`;
                    }
                    if(ri===0){
                        h+=`<td rowspan="${rowSpan}"><button class="resp-delete" data-resp-id="${resp.id}" title="刪除">✕</button></td>`;
                    }
                    h+=`</tr>`;
                });
            });
            h+='</tbody></table>';
            container.innerHTML=h;
            // Event delegation for delete buttons
            container.querySelectorAll('.resp-delete').forEach(btn=>{
                btn.addEventListener('click',async function(){
                    const responseId=this.dataset.respId;
                    if(!confirm('確定刪除此回應？'))return;
                    try{
                        const r=await fetch(`/api/sessions/${sessionId}/responses/${responseId}`,{
                            method:'DELETE',
                            headers:getAuthHeaders()
                        });
                        if(r.ok){toast('已刪除');loadResponses()}else throw new Error('刪除失敗')
                    }catch(e){toast(e.message,1)}
                });
            });
        }catch(e){container.innerHTML=`<p style="padding:24px;color:#dc2626;text-align:center">載入失敗：${escapeHtml(e.message)}</p>`;toast(e.message,1)}
    }

    document.getElementById('btn-export-csv').addEventListener('click',async()=>{
        if(!sessionId)return;
        try{
            const r=await fetch(`/api/sessions/${sessionId}/responses/export/csv`,{
                method:'POST',
                headers:getAuthHeaders()
            });
            if(!r.ok){const res=await r.json();throw new Error(res.detail||'匯出失敗');}
            const blob=await r.blob();
            const url=URL.createObjectURL(blob);
            const a=document.createElement('a');
            a.href=url;a.download=`responses_${sessionId}.csv`;
            document.body.appendChild(a);a.click();
            document.body.removeChild(a);URL.revokeObjectURL(url);
        }catch(e){toast(e.message,1)}
    });
    document.getElementById('btn-refresh-responses').addEventListener('click',loadResponses);

    document.getElementById('btn-submit-password').addEventListener('click',()=>{
        const pwd=document.getElementById('overlay-password-input').value.trim();
        if(!pwd){
            toast('請輸入密碼！',1);
            return;
        }
        sessionStorage.setItem('project_password_'+(sessionId||editSessionId),pwd);
        document.getElementById('overlay-password-input').value='';
        loadEditorSession();
    });
    document.getElementById('overlay-password-input').addEventListener('keydown',e=>{
        if(e.key==='Enter')document.getElementById('btn-submit-password').click();
    });

    window.addEventListener('beforeunload',e=>{if(isDirty){e.preventDefault();e.returnValue=''}});
})();

// ===== Fill Mode =====
async function initFillMode(){
    try{
        const [r, fnr]=await Promise.all([
            fetch(`/api/fill/${fillToken}/data`),
            fetch('/api/fund-names')
        ]);
        if(!r.ok)throw new Error('表單不存在或已取消發布');
        const res=await r.json();
        sessionId=res.session_id;
        fillFundCol=res.fund_col||0;
        data=res.data||[];
        if(fnr.ok){const fnj=await fnr.json();fundNames=fnj.names||[]}
        if(data.length<2){
            const maxC=data[0]?data[0].length:1;
            const nr=[];
            for(let c=0;c<maxC;c++)nr.push({value:''});
            data.push(nr);
        }
        original=JSON.parse(JSON.stringify(data));
        document.getElementById('file-name').textContent=res.name||'';
        buildFundDatalist();
        renderFillTable();
        bindFillImportEvents();
        bindFillHistoryLoad();
        document.getElementById('fill-mode').style.display='block';
    }catch(e){
        toast(e.message,1);
        document.getElementById('fill-mode').innerHTML=`<div class="submit-msg"><div class="icon">❌</div><h2>無法載入</h2><p>${escapeHtml(e.message)}</p></div>`;
        document.getElementById('fill-mode').style.display='block';
    }
}

function bindFillImportEvents(){
    const importBtn=document.getElementById('btn-fill-import-xlsx');
    const fileInput=document.getElementById('fill-file-input');
    if(!importBtn||!fileInput)return;
    importBtn.addEventListener('click',()=>fileInput.click());
    fileInput.addEventListener('change',async e=>{
        const file=e.target.files[0];
        if(!file)return;
        if(!file.name.match(/\.xlsx?$/i)){
            toast('請選擇 .xlsx 檔案',1);
            return;
        }
        const fd=new FormData();
        fd.append('file',file);
        toast('正在解析 Excel 檔案⋯');
        try{
            const r=await fetch('/api/parse-xlsx',{method:'POST',body:fd});
            const res=await r.json();
            if(!r.ok)throw new Error(res.detail||'解析失敗');
            const uploadedJson=res.json||[];
            if(!uploadedJson.length){
                toast('匯入的 Excel 無資料',1);
                return;
            }
            const currentHeaders=getHeaders();
            const uploadedHeaders=uploadedJson[0].map(c=>(c?c.value||'':''));
            if(currentHeaders.length!==uploadedHeaders.length){
                alert(`欄位數量不符！\n原表單欄位：[${currentHeaders.join(', ')}]\n上傳檔案欄位：[${uploadedHeaders.join(', ')}]`);
                fileInput.value='';
                return;
            }
            for(let i=0;i<currentHeaders.length;i++){
                if(currentHeaders[i].trim()!==uploadedHeaders[i].trim()){
                    alert(`欄位名稱不符！第 ${i+1} 欄應該為「${currentHeaders[i]}」，但上傳檔案中卻為「${uploadedHeaders[i]}」\n不開放匯入。`);
                    fileInput.value='';
                    return;
                }
            }
            data=uploadedJson;
            renderFillTable();
            toast(`已成功讀入 Excel 共 ${data.length-1} 筆資料！`);
        }catch(e){
            toast(e.message,1);
        }finally{
            fileInput.value='';
        }
    });
}

function bindFillHistoryLoad(){
    const loadLink=document.getElementById('link-fill-load-old');
    if(!loadLink)return;
    loadLink.addEventListener('click',async()=>{
        const email=prompt('請輸入您的填表 Email：');
        if(email===null)return;
        if(!email.trim()){
            toast('必須輸入 Email 才能載入紀錄',1);
            return;
        }
        const password=prompt('請輸入您當初設定的填表密碼：');
        if(password===null)return;
        if(!password.trim()){
            toast('必須輸入密碼才能載入紀錄',1);
            return;
        }
        toast('正在載入歷史填寫資料⋯');
        try{
            const r=await fetch(`/api/fill/${fillToken}/load-response`,{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({email:email.trim(),password:password.trim()})
            });
            const res=await r.json();
            if(!r.ok)throw new Error(res.detail||'載入失敗');
            data=res.data||[];
            document.getElementById('fill-respondent').value=res.respondent||'';
            document.getElementById('fill-email').value=email.trim();
            document.getElementById('fill-password').value=password.trim();
            renderFillTable();
            toast('已成功還原您之前的填表數據，您可以進行修改，隨後點擊「送出」即可重新儲存！');
        }catch(e){
            toast(e.message,1);
        }
    });
}

function buildFundDatalist(){
    let dl=document.getElementById('fund-names-list');
    if(dl)dl.remove();
    if(!fundNames.length)return;
    dl=document.createElement('datalist');
    dl.id='fund-names-list';
    fundNames.forEach(n=>{const o=document.createElement('option');o.value=n;dl.appendChild(o)});
    document.body.appendChild(dl);
}

function renderFillTable(){
    if(!data.length){document.getElementById('fill-table-container').innerHTML='';return}
    const maxC=Math.max(...data.map(r=>r.length||0),1);
    const hdrs=getHeaders();
    const nums=getNumerics();

    let h='<table id="fill-table"><thead><tr>';
    const hdrRow=data[0]||[];
    for(let c=0;c<maxC;c++){
        const hc=hdrRow[c]||{};
        if(hc._skip) continue;
        const spanAttr=(hc.rowspan>1?` rowspan="${hc.rowspan}"`:'')+(hc.colspan>1?` colspan="${hc.colspan}"`:'');
        const hMerged=(hc.rowspan>1||hc.colspan>1)?' class="merged-cell"':'';
        h+=`<th${hMerged}${spanAttr}>${escapeHtml(hdrs[c]||'')}</th>`;
    }
    h+='</tr></thead><tbody>';

    for(let r=1;r<data.length;r++){
        const row=data[r]||[];const name=row[0]?.value||'';const lv=detectLevel(name);
        h+=`<tr class="lv-${lv}">`;
        for(let c=0;c<Math.max(maxC,row.length);c++){
            const cell=row[c]||{};
            if(cell._skip) continue;
            const val=cell.value||'';
            const isNum=nums.includes(c);const isAuto=cell._autoSum;
            const spanAttr=(cell.rowspan>1?` rowspan="${cell.rowspan}"`:'')+(cell.colspan>1?` colspan="${cell.colspan}"`:'');
            const locked=cell._locked;
            const mCls=(cell.rowspan>1||cell.colspan>1)?' merged-cell':'';
            if(isAuto||locked){
                h+=`<td${mCls?` class="${mCls.trim()}"`:''} style="background:#fef3c7"${spanAttr}><input type="text" class="txt auto-sum" name="r${r}_c${c}_auto" value="${escapeHtml(val)}" disabled style="background:transparent;cursor:default"></td>`;
            } else {
                const cls=`${isNum?'num':'txt'}`;
                const dl=(c===fillFundCol&&fundNames.length)?' list="fund-names-list"':'';
                h+=`<td${mCls?` class="${mCls.trim()}"`:''}${spanAttr}><input type="text" class="${cls}" name="r${r}_c${c}" data-r="${r}" data-c="${c}" value="${escapeHtml(val)}"${dl} placeholder="${c===0?'名稱':'0'}"></td>`;
            }
        }
        h+='</tr>';
    }
    h+='</tbody></table>';
    const warn=hasMergedCells(data)?'<div class="merge-warn">⚠ 此表單含合併儲存格（黃底粗框處）。合併區域僅左上格可填寫、其餘格無法輸入；若您匯入的 Excel 含合併格，請核對資料是否正確。</div>':'';
    document.getElementById('fill-table-container').innerHTML=warn+h;

    document.querySelectorAll('#fill-table input:not([disabled])').forEach(inp=>{
        inp.addEventListener('change',onFillChange);
        inp.addEventListener('paste',onFillPaste);
    });
    document.getElementById('fill-submit-area').style.display='flex';
    document.getElementById('fill-success').style.display='none';
}

function onFillChange(e){
    const inp=e.target;const r=parseInt(inp.dataset.r),c=parseInt(inp.dataset.c);
    if(!data[r])data[r]=[];if(!data[r][c])data[r][c]={value:''};
    data[r][c].value=inp.value;
}

function onFillPaste(e){
    e.preventDefault();const inp=e.target;const r=parseInt(inp.dataset.r),c=parseInt(inp.dataset.c);
    const text=(e.clipboardData||window.clipboardData).getData('text');if(!text)return;
    const rows=text.split(/\r?\n/).filter(r=>r.trim());if(!rows.length)return;const cells=rows.map(r=>r.split('\t'));
    cells.forEach((rowData,ri)=>{const targetR=r+ri;while(data.length<=targetR)data.push([]);if(!data[targetR])data[targetR]=[];rowData.forEach((val,ci)=>{const targetC=c+ci;if(!data[targetR][targetC])data[targetR][targetC]={value:''};data[targetR][targetC].value=val.trim()})});
    renderFillTable();toast(`已貼上 ${cells.length} 列`);
}

document.getElementById('btn-fill-submit').addEventListener('click',async()=>{
    const respondent=document.getElementById('fill-respondent').value.trim();
    const email=document.getElementById('fill-email').value.trim();
    const password=document.getElementById('fill-password').value.trim();
    if((email&&!password)||(!email&&password)){
        toast('若要設定身分，Email 與填表密碼必須同時填寫！',1);
        return;
    }
    if(!confirm('確定送出填寫資料？'))return;
    try{
        const r=await fetch(`/api/fill/${fillToken}/submit`,{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({data,respondent,email,password})
        });
        if(!r.ok){
            const res=await r.json();
            throw new Error(res.detail||'送出失敗');
        }
        document.getElementById('fill-submit-area').style.display='none';
        document.getElementById('fill-success').style.display='block';
        toast('已成功送出');

        setTimeout(async () => {
            if (confirm("表單已成功送出！\n是否要產生並下載您的填表資料（XLSX 備份）？")) {
                const name = (document.getElementById('file-name').textContent || 'project').trim();
                const now = new Date();
                const timeStr = now.getFullYear() +
                    String(now.getMonth() + 1).padStart(2, '0') +
                    String(now.getDate()).padStart(2, '0') + '_' +
                    String(now.getHours()).padStart(2, '0') +
                    String(now.getMinutes()).padStart(2, '0') +
                    String(now.getSeconds()).padStart(2, '0');
                const filename = `${name.replace(/\.xlsx?$/i, '')}_${timeStr}_${respondent || '匿名'}.xlsx`;
                await downloadXlsxFile(name, data, filename);
            }
        }, 100);
    }catch(e){toast(e.message,1)}
});

document.getElementById('btn-fill-reset').addEventListener('click',()=>{
    data=JSON.parse(JSON.stringify(original));
    renderFillTable();
    toast('已重填');
});

document.getElementById('btn-fill-add-row').addEventListener('click',()=>{
    const maxC=Math.max(...data.map(r=>r.length),2);
    const nr=[];
    for(let c=0;c<maxC;c++)nr.push({value:''});
    data.push(nr);
    renderFillTable();
    toast('新增一列');
});

document.getElementById('btn-fill-del-row').addEventListener('click',()=>{
    if(data.length<=1){toast('至少保留一列',1);return}
    if(!confirm('刪除最後一列？'))return;
    data.pop();
    renderFillTable();
    toast('已刪除');
});

document.getElementById('btn-fill-another').addEventListener('click',()=>{
    const resp=document.getElementById('fill-respondent');
    if(resp)resp.value='';
    const emailInput=document.getElementById('fill-email');
    if(emailInput)emailInput.value='';
    const pwdInput=document.getElementById('fill-password');
    if(pwdInput)pwdInput.value='';
    data=JSON.parse(JSON.stringify(original));
    renderFillTable();
});
