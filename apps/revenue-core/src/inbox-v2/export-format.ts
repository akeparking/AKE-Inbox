import PDFDocument from 'pdfkit';
import { csvCell } from './policy';

function crc32(b:Buffer){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
// Store-only ZIP: binary originals are never transcoded. UTF-8 names, no executable paths.
export function zip(files:Record<string,Buffer>) {
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [path,data] of Object.entries(files)) {
    if(path.startsWith('/')||path.split('/').includes('..')||path.includes('\\'))throw new Error('unsafe_export_path');
    const name=Buffer.from(path),crc=crc32(data),h=Buffer.alloc(30),d=Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);
    d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt16LE(0x800,8);d.writeUInt32LE(crc,16);d.writeUInt32LE(data.length,20);d.writeUInt32LE(data.length,24);d.writeUInt16LE(name.length,28);d.writeUInt32LE(offset,42);
    local.push(h,name,data);central.push(d,name);offset+=h.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
const xml=(s:any)=>String(s??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function xlsx(rows:unknown[][]) {
  const col=(n:number)=>{let out='';for(n++;n;n=Math.floor((n-1)/26))out=String.fromCharCode(65+(n-1)%26)+out;return out;};
  return zip(Object.fromEntries(Object.entries({
    '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inbox" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows.map((row,r)=>`<row r="${r+1}">`+row.map((v,c)=>typeof v==='number'?`<c r="${col(c)}${r+1}"><v>${v}</v></c>`:`<c r="${col(c)}${r+1}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')+'</row>').join('')+'</sheetData></worksheet>',
  }).map(([name,value])=>[name,Buffer.from(value)])));
}
export function csv(rows:unknown[][]){return Buffer.from('\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'));}
export async function pdf(rows:unknown[][]) {
  const doc=new PDFDocument({size:'A4',margin:40,info:{Title:'AKE Inbox conversation export'}}),chunks:Buffer[]=[];
  const done=new Promise<Buffer>((resolve,reject)=>{doc.on('data',x=>chunks.push(x));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const font=process.env.INBOX_PDF_FONT;
  if(font)doc.font(font);
  else if(rows.some(r=>r.some(v=>/[^\x00-\x7f]/.test(String(v)))))throw new Error('unicode_pdf_font_required');
  doc.fontSize(18).text('AKE Inbox · v0.2').moveDown();
  for(const row of rows.slice(1)) {
    doc.fontSize(9).fillColor('#68746c').text(`${row[0]} · ${row[1]} · ${row[2]} · ${row[3]}`);
    doc.fontSize(11).fillColor('#17261d').text(String(row[4]||''),{width:510}).moveDown();
    if(row[5])doc.fontSize(9).text('Attachments: '+String(row[5])).moveDown();
  }
  doc.end();return done;
}
