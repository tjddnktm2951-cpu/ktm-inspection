// ╔══════════════════════════════════════════════════════════════╗
// ║   SUNGWOO KTM 설비점검 시스템 - Apps Script (통합 신버전)    ║
// ║   사용 전 ① SPREADSHEET_ID  ② DRIVE_FOLDER_ID 를 설정하세요 ║
// ╚══════════════════════════════════════════════════════════════╝

// ▼▼▼▼▼ ★ 반드시 본인 값으로 교체 ★ ▼▼▼▼▼
const SPREADSHEET_ID  = '1_3UiY4rbF0HY429kW1CY0gejmCXr9-Rg1SsSiXFCJZ4';
const DRIVE_FOLDER_ID = '1_z3362NbE5eU3HZjzH29hQmQyMIPv6uW';

// 각 formType 에 대응하는 시트(탭) 이름
// ※ 설비점검은 설비별로 시트 분리
const SHEET_NAMES = {
  equip_성형연마기: '성형연마기',
  equip_콘도머신:  '콘도머신',
  equip_밀링2호기: '밀링2호기',
  equip_CNC10호기: 'CNC10호기',
  press:    '프레스점검',
  radial:   '레디알점검',
  air:      '에어컴프레서',
  downtime: '가동중단관리',
  // 수입검사 통합관리 (3종) — _id 기반 upsert/delete 사용
  inspection: '수입검사대장',
  ncr:        '부적합NCR',
  heat:       '열처리성적서',
  // 3정5S 활동 평가 — _id 기반 upsert/delete (NCR 패턴 차용)
  s5s:        '3정5S평가'
};

// 시트 헤더 (첫 행, 최초 1회만 자동 생성)
const SHEET_HEADERS = {
  equip_성형연마기: ['제출시간','날짜','점검자','설비명','오일게이지(유량)','연마석상태','특이사항','사진링크'],
  equip_콘도머신:  ['제출시간','날짜','점검자','설비명','톱날상태(육안)','톱날정위치확인','특이사항','사진링크'],
  equip_밀링2호기: ['제출시간','날짜','점검자','설비명','벨트상태','오일점검(베드)','특이사항','사진링크'],
  equip_CNC10호기: ['제출시간','날짜','점검자','설비명','슬동유탱크유량','스핀들온도','절삭유유량','에어유니트압력(MPa)','절삭유농도(%)','특이사항','사진링크'],
  press:    ['제출시간','날짜','설비명','점검자','안전센서','OK마스터','오일레벨','금형클램프','V.S레버','메인에어(kgf)','클러치(kgf)','전압(V)','특이사항','서명여부','사진링크'],
  radial:   ['제출시간','날짜','점검자','설비명','오일레벨','유/공압','작동램프','이송/고정','절삭유','변속RPM','척/전원','소음청결','특이사항','사진링크'],
  air:      ['제출시간','날짜','점검자','오일레벨','응축수배출','흡입필터','배관누설','토출압력(MPa)','토출온도(℃)','가동시간(h)','특이사항','사진링크'],
  downtime: ['제출시간','발생일시','설비명','중단유형','중단사유','점검카테고리','점검완료항목','진행률','조치내용','작업자'],
  // 수입검사 통합관리
  inspection: ['_id','차종','품번','입고일','품명','규격','재질','수량','수량판정','외관','외관치수','종합판정','비고','수정시간'],
  ncr:        ['_id','No','작성일','품명','품번','불량유형','발생원인','대책내용','담당자','전사진URLs','후사진URLs','수정시간'],
  heat:       ['_id','jobKey','차종','도번','발신','날짜','연도1','연도2','사인0URL','사인1URL','사인2URL','rowsJSON','첨부URLs','수정시간'],
  // 3정5S 평가: 13항목 점수 + 등급 + 지적/개선 사진 URL 배열 + 개선일자
  s5s:        ['_id','평가일','구역','평가자','관리담당정','관리담당부','점수JSON','합계','등급','지적사진URLs','개선사진URLs','개선일자','비고','수정시간']
};

// 앱에서 보내는 machine 값 → SHEET_NAMES 키 매핑
const MACHINE_TYPE_MAP = {
  '성형연마기': 'equip_성형연마기',
  '콘도머신':   'equip_콘도머신',
  '밀링2호기':  'equip_밀링2호기',
  'CNC 10호기': 'equip_CNC10호기'
};

// ─────────────────────────────────────────────────────────────
// POST: 점검 데이터 수신 → 사진 Drive 저장 → 시트 기록
// ─────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const payload  = JSON.parse(e.postData.contents);
    const formType = payload.formType;

    // ── 수입검사 통합관리: upsert / delete (3종) ──
    if (/^(inspection|ncr|heat)_(upsert|delete)$/.test(formType)) {
      const m = formType.match(/^(.+)_(upsert|delete)$/);
      if (m[2] === 'upsert') return jsonRes(handleQmsUpsert(m[1], payload));
      if (m[2] === 'delete') return jsonRes(handleQmsDelete(m[1], payload));
    }

    // ── 3정5S 활동 평가: upsert / delete ──
    if (/^s5s_(upsert|delete)$/.test(formType)) {
      if (formType === 's5s_upsert') return jsonRes(handleS5sUpsert(payload));
      if (formType === 's5s_delete') return jsonRes(handleS5sDelete(payload));
    }

    // equip 타입이면 machine 값으로 설비별 시트 분기
    let resolvedType = formType;
    if (formType === 'equip' && payload.machine) {
      resolvedType = MACHINE_TYPE_MAP[payload.machine] || null;
      if (!resolvedType) {
        return jsonRes({ status: 'error', message: '알 수 없는 설비명: ' + payload.machine });
      }
    }

    if (!SHEET_NAMES[resolvedType]) {
      return jsonRes({ status: 'error', message: 'Unknown formType: ' + resolvedType });
    }

    // ① 사진 base64 → Google Drive 업로드
    let imageUrl = '';
    if (payload.imageBase64 && payload.imageBase64.length > 100) {
      imageUrl = saveImageToDrive(payload.imageBase64, payload.date, resolvedType);
    }

    // ② 시트에 행 추가
    const ss        = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheetName = SHEET_NAMES[resolvedType];
    let sheet       = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);

    // 헤더 행 (처음 한 번만)
    if (sheet.getLastRow() === 0) {
      const hdr = SHEET_HEADERS[resolvedType];
      sheet.appendRow(hdr);
      sheet.getRange(1, 1, 1, hdr.length)
           .setBackground('#1e3a5f')
           .setFontColor('white')
           .setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // 데이터 행
    const row = buildRow(resolvedType, payload, imageUrl);
    sheet.appendRow(row);

    // ③ 사진링크 컬럼에 클릭 가능한 HYPERLINK 수식 삽입
    if (imageUrl) {
      const lastRow = sheet.getLastRow();
      const imgCol  = SHEET_HEADERS[resolvedType].indexOf('사진링크') + 1;
      if (imgCol > 0) {
        sheet.getRange(lastRow, imgCol)
             .setFormula('=HYPERLINK("' + imageUrl + '","📷 사진보기")');
      }
    }

    return jsonRes({ status: 'ok', imageUrl: imageUrl });

  } catch (err) {
    return jsonRes({ status: 'error', message: err.toString() });
  }
}

// ─────────────────────────────────────────────────────────────
// GET: 점검 기록 조회 JSON  /  기본: 뷰어 HTML 페이지
// ─────────────────────────────────────────────────────────────
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';

  if (action === 'getRecords') {
    const type    = (e.parameter.type) || 'equip_성형연마기';
    const records = getSheetData(type);
    return jsonRes({ status: 'ok', records: records });
  }

  // 수입검사 통합관리 — 객체 배열로 전체 로드
  if (action === 'loadAll') {
    const type = e.parameter.type || '';
    return jsonRes({ status: 'ok', records: handleQmsLoadAll(type) });
  }

  // 기본: 브라우저에서 URL 열면 웹 뷰어 페이지
  return HtmlService.createHtmlOutput(buildViewerHtml())
    .setTitle('SUNGWOO KTM 점검기록 조회')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ─────────────────────────────────────────────────────────────
// Google Drive 이미지 저장
// ─────────────────────────────────────────────────────────────
function saveImageToDrive(base64DataUrl, date, formType) {
  const parts    = base64DataUrl.split(',');
  const mimeType = parts[0].split(':')[1].split(';')[0];   // image/jpeg | image/png
  const base64   = parts[1];
  const ext      = mimeType.includes('png') ? 'png' : 'jpg';
  const dateStr  = date || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  const fileName = 'KTM_' + formType + '_' + dateStr + '_' + Date.now() + '.' + ext;

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const blob   = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, fileName);
  const file   = folder.createFile(blob);

  // 링크를 가진 누구나 볼 수 있도록 공유 설정
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // 브라우저에서 직접 열리는 이미지 URL
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

// ─────────────────────────────────────────────────────────────
// 시트 데이터 읽기 (뷰어용)
// ─────────────────────────────────────────────────────────────
function getSheetData(type) {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAMES[type]);
    if (!sheet || sheet.getLastRow() < 1) return [];

    return sheet.getDataRange().getValues().map(function(row) {
      return row.map(function(cell) {
        if (cell instanceof Date) {
          return Utilities.formatDate(cell, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
        }
        return cell;
      });
    });
  } catch (err) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 행 데이터 빌더 (formType별)
// ─────────────────────────────────────────────────────────────
function buildRow(formType, p, imageUrl) {
  const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  if (formType === 'equip_성형연마기') {
    return [now, p.date||'', p.inspector||'', p.machine||'',
            p.oil_gauge||'', p.abrasive||'',
            p.memo||'', imageUrl];
  }

  if (formType === 'equip_콘도머신') {
    return [now, p.date||'', p.inspector||'', p.machine||'',
            p.blade_cond||'', p.blade_pos||'',
            p.memo||'', imageUrl];
  }

  if (formType === 'equip_밀링2호기') {
    return [now, p.date||'', p.inspector||'', p.machine||'',
            p.belt||'', p.bed_oil||'',
            p.memo||'', imageUrl];
  }

  if (formType === 'equip_CNC10호기') {
    return [now, p.date||'', p.inspector||'', p.machine||'',
            p.slide_oil||'', p.spindle_temp||'', p.coolant_level||'',
            p.val_air_pressure||'', p.val_concentration||'',
            p.memo||'', imageUrl];
  }

  if (formType === 'press') {
    return [now, p.date||'', p.machine||'', p.inspector||'',
            p.c_safety||'', p.c_ok||'', p.c_oil||'', p.c_clamp||'', p.c_vs||'',
            p.m_air||'', p.m_clutch||'', p.m_volt||'',
            p.memo||'', p.signature ? '서명있음' : '없음', imageUrl];
  }

  if (formType === 'radial') {
    return [now, p.date||'', p.inspector||'', p.machine||'',
            p.item1||'', p.item2||'', p.item3||'', p.item4||'',
            p.item5||'', p.item6||'', p.item7||'', p.item8||'',
            p.memo||'', imageUrl];
  }

  if (formType === 'air') {
    return [now, p.date||'', p.inspector||'',
            p.c_oil||'', p.c_drain||'', p.c_filter||'', p.c_leak||'',
            p.n_pressure||'', p.n_temp||'', p.n_hours||'',
            p.memo||'', imageUrl];
  }

  if (formType === 'downtime') {
    // 발생일시(p.date)는 'YYYY-MM-DD HH:mm' 형식, 그대로 저장
    return [now, p.date||'', p.machine||'', p.stopType||'', p.reason||'',
            p.categories||'', p.checklistDetail||'', p.progress||'',
            p.action||'', p.worker||''];
  }

  return [now, JSON.stringify(p)]; // fallback
}

// ─────────────────────────────────────────────────────────────
// 유틸: JSON 응답
// ─────────────────────────────────────────────────────────────
function jsonRes(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────
// 뷰어 HTML (브라우저로 직접 접근 시 제공)
// ─────────────────────────────────────────────────────────────
function buildViewerHtml() {
  const scriptUrl = ScriptApp.getService().getUrl();
  return '<!DOCTYPE html>\n'
       + '<html lang="ko"><head>\n'
       + '<meta charset="UTF-8">\n'
       + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
       + '<title>SUNGWOO KTM 점검기록 조회</title>\n'
       + '<style>\n'
       + '*{margin:0;padding:0;box-sizing:border-box;}\n'
       + 'body{font-family:\'Noto Sans KR\',sans-serif;background:#f1f5f9;min-height:100vh;}\n'
       + '.header{background:#1e3a5f;color:white;padding:16px 22px;display:flex;align-items:center;gap:12px;}\n'
       + '.header h1{font-size:18px;font-weight:900;}\n'
       + '.toolbar{background:white;padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #e2e8f0;}\n'
       + 'select,button{padding:8px 14px;border-radius:8px;border:1px solid #cbd5e1;font-size:13px;font-weight:700;}\n'
       + 'button{background:#1e3a5f;color:white;border-color:#1e3a5f;cursor:pointer;}\n'
       + 'button:hover{background:#2d4f7c;}\n'
       + '.status{font-size:12px;color:#94a3b8;margin-left:auto;}\n'
       + '.wrap{padding:16px;overflow:auto;}\n'
       + 'table{width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden;box-shadow:0 1px 8px rgba(0,0,0,.07);}\n'
       + 'th{background:#1e3a5f;color:white;padding:10px 9px;text-align:center;white-space:nowrap;font-size:11px;}\n'
       + 'td{padding:9px 8px;border-bottom:1px solid #f1f5f9;text-align:center;white-space:nowrap;font-size:11px;}\n'
       + 'tr:last-child td{border-bottom:none;} tr:hover td{background:#f8faff;}\n'
       + '.pic{font-size:22px;cursor:pointer;display:inline-block;transition:transform .15s;}\n'
       + '.pic:hover{transform:scale(1.35);}\n'
       + '#popup{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:999;align-items:center;justify-content:center;}\n'
       + '#popup.show{display:flex;}\n'
       + '.pbox{position:relative;display:flex;flex-direction:column;align-items:center;gap:14px;}\n'
       + '.pbox img{max-width:90vw;max-height:74vh;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.5);}\n'
       + '.cls{position:absolute;top:-18px;right:-18px;width:38px;height:38px;background:#ef4444;color:white;border:none;border-radius:50%;font-size:20px;cursor:pointer;font-weight:bold;}\n'
       + '.prt{padding:12px 36px;background:#1155ff;color:white;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;}\n'
       + '#hov{position:fixed;display:none;pointer-events:none;background:white;border-radius:10px;box-shadow:0 6px 28px rgba(0,0,0,.4);padding:8px;z-index:998;}\n'
       + '#hov img{max-width:260px;max-height:200px;border-radius:6px;}\n'
       + '.empty{padding:48px;text-align:center;color:#94a3b8;}\n'
       + '@media print{#popup .prt,.cls,body>*:not(#printArea){display:none;}}\n'
       + '</style></head><body>\n'
       + '<div class="header"><span style="font-size:28px">🏭</span><h1>SUNGWOO KTM 점검기록 조회</h1></div>\n'
       + '<div class="toolbar">\n'
       + '  <select id="t">\n'
       + '    <optgroup label="설비 점검">\n'
       + '      <option value="equip_성형연마기">성형연마기</option>\n'
       + '      <option value="equip_콘도머신">콘도머신</option>\n'
       + '      <option value="equip_밀링2호기">밀링2호기</option>\n'
       + '      <option value="equip_CNC10호기">CNC 10호기</option>\n'
       + '    </optgroup>\n'
       + '    <option value="press">프레스 점검</option>\n'
       + '    <option value="radial">레디알 점검</option>\n'
       + '    <option value="air">에어 컴프레서</option>\n'
       + '    <option value="downtime">🚨 가동중단 관리</option>\n'
       + '    <option value="s5s">🧹 3정5S 평가</option>\n'
       + '  </select>\n'
       + '  <button onclick="load()">🔍 조회</button>\n'
       + '  <span id="st" class="status"></span>\n'
       + '</div>\n'
       + '<div class="wrap" id="wrap"><p class="empty">유형을 선택하고 조회 버튼을 누르세요</p></div>\n'
       + '<div id="popup" onclick="if(event.target===this)close2()"><div class="pbox"><button class="cls" onclick="close2()">×</button><img id="pi" src="" alt="점검 사진"><button class="prt" onclick="doPrint()">🖨️ 인쇄하기</button></div></div>\n'
       + '<div id="hov"><img id="hi" src="" alt=""></div>\n'
       + '<script>\n'
       + 'const SURL="' + scriptUrl + '";\n'
       + 'async function load(){\n'
       + '  const type=document.getElementById("t").value;\n'
       + '  const st=document.getElementById("st");\n'
       + '  const wrap=document.getElementById("wrap");\n'
       + '  st.textContent="⏳ 불러오는 중...";\n'
       + '  wrap.innerHTML=\'<p class="empty">⏳ 로딩 중...</p>\';\n'
       + '  try{\n'
       + '    const res=await fetch(SURL+"?action=getRecords&type="+type);\n'
       + '    const data=await res.json();\n'
       + '    const rows=data.records||[];\n'
       + '    if(rows.length<2){wrap.innerHTML=\'<p class="empty">데이터가 없습니다.</p>\';st.textContent="0건";return;}\n'
       + '    render(rows,wrap);\n'
       + '    st.textContent=(rows.length-1)+"건 조회됨 (최신순)";\n'
       + '  }catch(err){\n'
       + '    st.textContent="조회 실패";\n'
       + '    wrap.innerHTML=\'<p class="empty" style="color:#ef4444">오류: \'+err.message+\'</p>\';\n'
       + '  }\n'
       + '}\n'
       + 'function render(records,wrap){\n'
       + '  const headers=records[0];\n'
       + '  const rows=records.slice(1).reverse();\n'
       + '  const imgIdx=headers.indexOf("사진링크");\n'
       + '  let html=\'<table><thead><tr>\';\n'
       + '  headers.forEach(h=>{html+=\'<th>\'+h+\'</th>\';});\n'
       + '  html+=\'</tr></thead><tbody>\';\n'
       + '  rows.forEach(row=>{\n'
       + '    html+=\'<tr>\';\n'
       + '    row.forEach((cell,i)=>{\n'
       + '      if(i===imgIdx){\n'
       + '        const url=String(cell||"");\n'
       + '        if(url.startsWith("http")){\n'
       + '          html+=\'<td><span class="pic" onmouseenter="showH(event,\\\'\'+url+\'\\\')" onmouseleave="hideH()" onclick="openP(\\\'\'+url+\'\\\')" title="마우스 올리기: 미리보기 / 클릭: 확대">📷</span></td>\';\n'
       + '        } else { html+=\'<td style="color:#cbd5e1">-</td>\'; }\n'
       + '      } else {\n'
       + '        html+=\'<td>\'+(cell!==null&&cell!==undefined?String(cell):"-")+\'</td>\';\n'
       + '      }\n'
       + '    });\n'
       + '    html+=\'</tr>\';\n'
       + '  });\n'
       + '  html+=\'</tbody></table>\';\n'
       + '  wrap.innerHTML=html;\n'
       + '}\n'
       + 'function showH(e,url){const hov=document.getElementById("hov");document.getElementById("hi").src=url;hov.style.display="block";const x=Math.min(e.clientX+18,window.innerWidth-290);const y=Math.max(e.clientY-120,10);hov.style.left=x+"px";hov.style.top=y+"px";}\n'
       + 'function hideH(){document.getElementById("hov").style.display="none";}\n'
       + 'function openP(url){document.getElementById("pi").src=url;document.getElementById("popup").classList.add("show");}\n'
       + 'function close2(){document.getElementById("popup").classList.remove("show");}\n'
       + 'function doPrint(){const url=document.getElementById("pi").src;const w=window.open("","_blank");w.document.write("<!DOCTYPE html><html><head><title>점검 사진 인쇄</title><style>body{margin:20px;text-align:center}img{max-width:100%;max-height:85vh;border-radius:8px}.pb{margin-top:16px;padding:12px 32px;background:#1155ff;color:white;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}@media print{.pb{display:none}}</style></head><body><img src=\\""+url+"\\"><br><button class=\'pb\' onclick=\'window.print()\'>🖨️ 인쇄</button></body></html>");w.document.close();}\n'
       + '<\/script>\n'
       + '</body></html>';
}

// ════════════════════════════════════════════════════════════
// 수입검사 통합관리 — _id 기반 upsert/delete/loadAll
// ════════════════════════════════════════════════════════════

function handleQmsUpsert(type, p) {
  if (!SHEET_NAMES[type]) return { status: 'error', message: 'unknown type: ' + type };
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheetName = SHEET_NAMES[type];
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  // 헤더 행 (처음 한 번만)
  if (sheet.getLastRow() === 0) {
    const hdr = SHEET_HEADERS[type];
    sheet.appendRow(hdr);
    sheet.getRange(1, 1, 1, hdr.length)
         .setBackground('#1e3a5f').setFontColor('white').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  // _id 확보
  if (!p._id) p._id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // 사진/파일 base64 → Drive URL 변환
  if (type === 'ncr') {
    p.beforeUrls = uploadPhotoArray(p.beforePhotos, p._id, 'ncr_before');
    p.afterUrls  = uploadPhotoArray(p.afterPhotos,  p._id, 'ncr_after');
  }
  if (type === 'heat') {
    if (Array.isArray(p.signs)) {
      p.signUrls = p.signs.map((s, i) => {
        if (!s) return '';
        if (typeof s === 'string' && s.startsWith('http')) return s;
        if (typeof s === 'string' && s.startsWith('data:')) return saveImageToDrive(s, p.date || '', 'heat_sign_' + i);
        return '';
      });
    } else {
      p.signUrls = ['', '', ''];
    }
    if (Array.isArray(p.atts)) {
      p.attUrls = p.atts.map(a => {
        if (a.url && String(a.url).startsWith('http')) return { name: a.name, type: a.type || '', url: a.url };
        if (a.b64) return { name: a.name, type: a.type || '', url: saveFileToDrive(a.b64, a.name, 'heat_att') };
        return null;
      }).filter(Boolean);
    } else {
      p.attUrls = [];
    }
  }

  const row = buildQmsRow(type, p);

  // 기존 행 찾기 (_id 매칭)
  const last = sheet.getLastRow();
  let foundRow = -1;
  if (last > 1) {
    const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(p._id)) { foundRow = i + 2; break; }
    }
  }

  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  return {
    status: 'ok', _id: p._id,
    beforeUrls: p.beforeUrls || null,
    afterUrls:  p.afterUrls  || null,
    signUrls:   p.signUrls   || null,
    attUrls:    p.attUrls    || null
  };
}

function handleQmsDelete(type, p) {
  if (!SHEET_NAMES[type]) return { status: 'error', message: 'unknown type: ' + type };
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAMES[type]);
  if (!sheet) return { status: 'ok', deleted: 0 };

  const last = sheet.getLastRow();
  if (last < 2) return { status: 'ok', deleted: 0 };

  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(p._id)) {
      sheet.deleteRow(i + 2);
      return { status: 'ok', deleted: 1 };
    }
  }
  return { status: 'ok', deleted: 0 };
}

function handleQmsLoadAll(type) {
  if (!SHEET_NAMES[type]) return [];
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAMES[type]);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  const tz = 'Asia/Seoul';
  return data.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      let v = row[i];
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
      obj[h] = (v === null || v === undefined) ? '' : v;
    });
    return obj;
  });
}

function buildQmsRow(type, p) {
  const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  if (type === 'inspection') {
    return [p._id, p.차종||'', p.품번||'', p.입고일||'', p.품명||'', p.규격||'',
            p.재질||'', p.수량||'', p.수량판정||'', p.외관||'', p.외관치수||'',
            p.종합판정||'', p.비고||'', now];
  }
  if (type === 'ncr') {
    return [p._id, p.No||'', p.작성일||'', p.품명||'', p.품번||'', p.불량유형||'',
            p.발생원인||'', p.대책내용||'', p.담당자||'',
            JSON.stringify(p.beforeUrls || []),
            JSON.stringify(p.afterUrls  || []),
            now];
  }
  if (type === 'heat') {
    const su = p.signUrls || ['','',''];
    return [p._id, p.jobKey||'', p.차종||'', p.도번||'', p.발신||'', p.날짜||'',
            p.연도1||'', p.연도2||'',
            su[0]||'', su[1]||'', su[2]||'',
            JSON.stringify(p.rows || []),
            JSON.stringify(p.attUrls || []),
            now];
  }
  return [];
}

function uploadPhotoArray(arr, recId, prefix) {
  if (!Array.isArray(arr)) return [];
  return arr.map((p, i) => {
    if (!p) return null;
    if (p.url && String(p.url).startsWith('http')) {
      return { name: p.name || '', url: p.url, caption: p.caption || '' };
    }
    if (p.b64) {
      const url = saveImageToDrive(p.b64, recId + '_' + i, prefix);
      return { name: p.name || '', url: url, caption: p.caption || '' };
    }
    return null;
  }).filter(Boolean);
}

function saveFileToDrive(base64DataUrl, originalName, formType) {
  const parts = base64DataUrl.split(',');
  const mimeType = parts[0].split(':')[1].split(';')[0];
  const base64 = parts[1];
  const ts = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd_HHmmss');
  const safeName = String(originalName || 'file').replace(/[^\wㄱ-힝.\-]/g, '_').slice(0, 60);
  const fileName = 'KTM_' + formType + '_' + ts + '_' + safeName;
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, fileName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?id=' + file.getId();
}

// ════════════════════════════════════════════════════════════
// 3정5S 활동 평가 — upsert / delete / loadAll
// 폴더 구조: {DRIVE_FOLDER_ID}/3정5S 평가/{YYYY-MM}/{구역}구역/
// ════════════════════════════════════════════════════════════

function getOrCreateSubFolder_(parentFolder, name) {
  const it = parentFolder.getFoldersByName(name);
  return it.hasNext() ? it.next() : parentFolder.createFolder(name);
}

function saveS5sImageToDrive_(base64DataUrl, evalDate, zone, kind) {
  // kind: '지적' | '개선'
  const parts    = base64DataUrl.split(',');
  const mimeType = parts[0].split(':')[1].split(';')[0];
  const base64   = parts[1];
  const ext      = mimeType.indexOf('png') >= 0 ? 'png' : 'jpg';
  const ymd      = evalDate || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  const ym       = ymd.substring(0, 7); // YYYY-MM
  const fileName = 'KTM_3s5s_' + kind + '_' + ymd.replace(/-/g,'') + '_' + Date.now() + '.' + ext;

  const root  = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const lvl1  = getOrCreateSubFolder_(root, '3정5S 평가');
  const lvl2  = getOrCreateSubFolder_(lvl1, ym);
  const lvl3  = getOrCreateSubFolder_(lvl2, (zone || '') + '구역');

  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, fileName);
  const file = lvl3.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function uploadS5sPhotos_(arr, evalDate, zone, kind) {
  if (!Array.isArray(arr)) return [];
  return arr.map(function(p) {
    if (!p) return null;
    if (p.url && String(p.url).indexOf('http') === 0) {
      // 이미 업로드된 사진 — 그대로 유지
      return { url: p.url, caption: p.caption || '', itemNo: p.itemNo || '' };
    }
    if (p.b64) {
      const url = saveS5sImageToDrive_(p.b64, evalDate, zone, kind);
      return { url: url, caption: p.caption || '', itemNo: p.itemNo || '' };
    }
    return null;
  }).filter(Boolean);
}

function calcS5sGrade_(total) {
  if (total >= 125) return 'A';
  if (total >= 105) return 'B';
  if (total >= 80)  return 'C';
  return 'D';
}

function buildS5sRow_(p) {
  const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  return [
    p._id,
    p.평가일 || '',
    p.구역 || '',
    p.평가자 || '',
    p.관리담당정 || '',
    p.관리담당부 || '',
    JSON.stringify(p.점수 || {}),
    p.합계 || 0,
    p.등급 || '',
    JSON.stringify(p.지적사진URLs || []),
    JSON.stringify(p.개선사진URLs || []),
    p.개선일자 || '',
    p.비고 || '',
    now
  ];
}

function handleS5sUpsert(p) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheetName = SHEET_NAMES.s5s;
  const hdrs = SHEET_HEADERS.s5s;
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(hdrs);
    sheet.getRange(1, 1, 1, hdrs.length)
         .setBackground('#1e3a5f').setFontColor('white').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  if (!p._id) p._id = 's5s_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // 기존 행 찾기 + 머지 (개선 사진만 업로드되는 경우 기존 데이터 보존)
  const last = sheet.getLastRow();
  let foundRow = -1;
  let existing = null;
  if (last > 1) {
    const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(p._id)) { foundRow = i + 2; break; }
    }
    if (foundRow > 0) {
      const rowVals = sheet.getRange(foundRow, 1, 1, hdrs.length).getValues()[0];
      existing = {};
      hdrs.forEach(function(h, i) { existing[h] = rowVals[i]; });
    }
  }

  if (existing) {
    if (!p.평가일)      p.평가일      = existing['평가일'] || '';
    if (!p.구역)         p.구역         = existing['구역'] || '';
    if (!p.평가자)      p.평가자      = existing['평가자'] || '';
    if (!p.관리담당정) p.관리담당정 = existing['관리담당정'] || '';
    if (!p.관리담당부) p.관리담당부 = existing['관리담당부'] || '';
    if (!p.비고)         p.비고         = existing['비고'] || '';
    if (!p.개선일자)   p.개선일자   = existing['개선일자'] || '';
    if (!p.점수 || Object.keys(p.점수).length === 0) {
      try { p.점수 = JSON.parse(existing['점수JSON'] || '{}'); } catch(e) { p.점수 = {}; }
    }
  }

  // 합계·등급 서버 측 재계산
  let total = 0;
  if (p.점수 && typeof p.점수 === 'object') {
    Object.keys(p.점수).forEach(function(k) {
      const v = parseInt(p.점수[k], 10);
      if (!isNaN(v)) total += v;
    });
  }
  p.합계 = total;
  p.등급 = calcS5sGrade_(total);

  // 신규 사진만 업로드 (b64) — 기존 URL은 그대로 유지
  const newBef = uploadS5sPhotos_(p.지적사진, p.평가일, p.구역, '지적');
  const newAft = uploadS5sPhotos_(p.개선사진, p.개선일자 || p.평가일, p.구역, '개선');
  let exBef = [], exAft = [];
  if (existing) {
    try { exBef = JSON.parse(existing['지적사진URLs'] || '[]'); } catch(e) {}
    try { exAft = JSON.parse(existing['개선사진URLs'] || '[]'); } catch(e) {}
  }
  p.지적사진URLs = exBef.concat(newBef);
  p.개선사진URLs = exAft.concat(newAft);

  const row = buildS5sRow_(p);

  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  return {
    status: 'ok',
    _id: p._id,
    합계: p.합계,
    등급: p.등급,
    지적사진URLs: p.지적사진URLs,
    개선사진URLs: p.개선사진URLs
  };
}

function handleS5sDelete(p) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAMES.s5s);
  if (!sheet) return { status: 'ok', deleted: 0 };

  const last = sheet.getLastRow();
  if (last < 2) return { status: 'ok', deleted: 0 };

  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(p._id)) {
      sheet.deleteRow(i + 2);
      return { status: 'ok', deleted: 1 };
    }
  }
  return { status: 'ok', deleted: 0 };
}
