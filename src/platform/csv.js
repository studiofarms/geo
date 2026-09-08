/** Parse CSV records, including quoted commas, newlines, escaped quotes, and BOM. */
export function parseCSV(value) {
  const rows=[]; let row=[],field='',quoted=false;
  const input=value.replace(/^\uFEFF/,'');
  for(let i=0;i<input.length;i++) {
    const char=input[i];
    if(char==='"') { if(quoted&&input[i+1]==='"'){field+='"';i++;}else quoted=!quoted; }
    else if(char===','&&!quoted){row.push(field.trim());field='';}
    else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&input[i+1]==='\n')i++;row.push(field.trim());if(row.some(Boolean))rows.push(row);row=[];field='';}
    else field+=char;
  }
  if(quoted)throw new Error('The CSV has an unclosed quoted field.');
  row.push(field.trim());if(row.some(Boolean))rows.push(row);
  if(!rows.length)return [];
  const index=rows[0].findIndex(cell=>/^e[ -]?mail(?:[ _-]?address)?$/i.test(cell));
  const data=index>=0?rows.slice(1):rows;
  const emails=data.map((r,i)=>{
    const email=index>=0?r[index]:r.find(cell=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cell));
    if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error(`CSV row ${i+(index>=0?2:1)} needs a valid email address.`);
    return email.toLowerCase();
  });
  return [...new Set(emails)];
}
export function manualEmails(value) {
  const list=value.split(/[;,\s]+/).map(email=>email.trim().toLowerCase()).filter(Boolean);
  if(list.some(email=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))throw new Error('Enter valid email addresses separated by commas or new lines.');
  return [...new Set(list)];
}
