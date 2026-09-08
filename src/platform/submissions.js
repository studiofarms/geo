import { app, act, closeModal, modal, e, toast, api, button } from './ui.js';
import { parseCSV, manualEmails } from './csv.js';
import { uuid } from '../random.js';
const iso=value=>new Date(value).toISOString();
const bool=(form,name)=>!!form.elements.namedItem(name)?.checked;
export function showInvitations(invitations) {
  if(!invitations?.length)return;
  modal('Invitations ready to share',`<p>These links expire in 14 days. Copy and share them with the intended people. No email has been sent.</p><div class="invitation-results">${invitations.map(item=>`<div><strong>${e(item.email)}</strong>${item.token?`<label class="field"><span class="sr-only">Invitation for ${e(item.email)}</span><input readonly value="${e(location.origin+'/portal.html?invite='+item.token)}"/></label><button class="btn small" data-action="copy-invite" data-token="${e(item.token)}">Copy invitation link</button>`:'<p>Already enrolled.</p>'}</div>`).join('')}</div>`);
}
export async function submit(form) {
  const formName=form.dataset.form, values=Object.fromEntries(new FormData(form));
  if(formName==='zoom'){
    await api('zoom/connect',{...values,waitingRoom:bool(form,'waitingRoom')});
    form.elements.namedItem('clientSecret').value='';await app.refresh();toast('Zoom connected and host verified.');return;
  }
  if(formName==='calendly'){
    await api('calendly/connect',{...values,enabled:bool(form,'enabled')});
    form.elements.namedItem('token').value='';
    await app.refresh();toast('Calendly settings saved.');return;
  }
  let payload={...values}, action;
  if(formName==='cohort'){action='save-cohort';payload={...values,startDate:iso(values.startDate),endDate:iso(values.endDate),emails:manualEmails(values.emails||'')};}
  if(formName==='buyer')action='save-buyer';
  if(formName==='lead')action='save-lead';
  if(formName==='invite'){
    const file=form.elements.csv.files[0];
    if(file&&file.size>1024*1024)throw new Error('Use a CSV smaller than 1 MB.');
    action='bulk-invite';payload={cohortId:values.cohortId,emails:[...new Set([...manualEmails(values.emails||''),...(file?parseCSV(await file.text()):[])])]};
  }
  if(formName==='session'){action='save-session';payload.startsAt=iso(values.startsAt);}
  if(formName==='poll'){action='create-poll';payload={...values,deadline:iso(values.deadline),slots:new FormData(form).getAll('slots').filter(Boolean).map(iso)};}
  if(formName==='poll-response'){action='respond-poll';payload={id:values.id,choices:Array.from({length:5},(_,i)=>Number(values[`rank${i}`]))};}
  if(formName==='document'){
    const file=form.elements.file.files[0];
    if(!file||file.size>3*1024*1024)throw new Error('Choose a file no larger than 3 MB.');
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    action='upload-document';payload={...values,file:undefined,filename:file.name,base64:btoa(binary)};
  }
  if(formName==='report'){action='save-report';payload.shareBuyer=bool(form,'shareBuyer');}
  if(formName==='survey'){action='save-survey';payload={...values,deadline:iso(values.deadline),questions:values.questions.split('\n').map(s=>s.trim()).filter(Boolean)};}
  if(formName==='survey-response'){const survey=app.data.surveys.find(s=>s.id===values.id);action='respond-survey';payload={id:values.id,answers:survey.questions.map((_,i)=>Number(values[`answer${i}`])),reflection:values.reflection};}
  if(formName==='invoice'){action='create-invoice';payload.dueDate=iso(values.dueDate+'T12:00:00');}
  if(formName==='payment'){action='record-payment';payload.date=iso(values.date+'T12:00:00');}
  if(formName==='contract')action='save-contract';
  if(formName==='acknowledgement'){action='acknowledge-contract';payload.consent=bool(form,'consent');}
  if(formName==='message')action='send-message';
  if(formName==='reminder-settings'){action='save-settings';payload={...app.data.settings,reminderOffsets:values.reminderOffsets.split(/[,\s]+/).filter(Boolean).map(Number),remindersEnabled:bool(form,'remindersEnabled')};}
  if(formName==='availability-settings'){action='save-settings';payload={...app.data.settings,...values,weekdays:new FormData(form).getAll('weekdays').map(Number)};}
  if(!action)throw new Error('This form is not available.');
  const fingerprint=JSON.stringify({action,payload});
  if(form._lastPayload!==fingerprint){form._requestKey=uuid();form._lastPayload=fingerprint;}
  const result=await act(action,payload,form._requestKey);
  closeModal();
  toast(formName==='message'?'Message delivered in the workspace.':formName==='acknowledgement'?'Local acknowledgement recorded.':formName==='document'?'Document shared with the selected audience.':'Saved. Your workspace is up to date.');
  if(result.invitations?.length)showInvitations(result.invitations);
}
