import { app, e, dt, localInput, money, who, buyerName, cohortName, isCoach, isBuyer, field, textarea, select, check, button, badge, table, empty, modal, cohortOptions } from './ui.js';
const hidden=(name,value)=>`<input type="hidden" name="${name}" value="${e(value)}"/>`;
export function invoiceForm() {
  if(!app.data.cohorts.length)return modal('Create a cohort first',empty('No cohort available'));
  modal('Create an invoice',`${select('Cohort / buyer','cohortId',cohortOptions(),app.cohortId)}${field('Invoice description','title','text','Group coaching cohort')}<div class="form-grid">${field('Amount ($)','amount','number','','min="0.01" step="0.01"')}${field('Payment due','dueDate','date',new Date(Date.now()+14*86400000).toISOString().slice(0,10))}</div><p class="help">The invoice starts as a draft. Issue it to make it visible in the buyer’s account.</p>`,'invoice');
}
export function invoiceDetail(id) {
  const invoice=app.data.invoices.find(i=>i.id===id);
  modal(invoice.number,`<article class="print-document"><div class="eyebrow">GoCoach · Invoice</div><div class="invoice-head"><div><h3>${e(invoice.title)}</h3><p>${e(buyerName(invoice.buyerId))}<br/>${e(cohortName(invoice.cohortId))}</p></div>${badge(invoice.displayStatus)}</div><dl class="invoice-totals"><div><dt>Total</dt><dd>${money(invoice.amount)}</dd></div><div><dt>Payments recorded</dt><dd>${money(invoice.paid)}</dd></div><div><dt>Outstanding</dt><dd>${money(invoice.balance)}</dd></div><div><dt>Due</dt><dd>${dt(invoice.dueDate)}</dd></div></dl><h3>Payment history</h3>${table(['Date','Amount','Method','Reference'],invoice.payments.map(p=>`<tr><td>${dt(p.date)}</td><td>${money(p.amount)}</td><td>${e(p.method)}</td><td>${e(p.reference)}</td></tr>`))}${!invoice.payments.length?'<p>No payments recorded yet.</p>':''}<p class="help">Payments are recorded manually. This prototype does not charge a payment method.</p></article><div class="card-actions">${button('Print / save as PDF','print','','primary')}${isCoach()?invoice.status==='draft'?button('Issue invoice','issue-invoice',id):invoice.balance>0?button('Record payment','record-payment',id):'':''}</div>`);
}
export function paymentForm(id) {
  const invoice=app.data.invoices.find(i=>i.id===id);
  modal('Record a received payment',`${hidden('id',id)}<p>${e(invoice.number)} · Outstanding: ${money(invoice.balance)}</p><div class="form-grid">${field('Received amount ($)','amount','number',invoice.balance/100,`min="0.01" max="${invoice.balance/100}" step="0.01"`)}${field('Date received','date','date',new Date().toISOString().slice(0,10))}${select('Method','method',['Bank transfer','Check','Cash','Other (record only)'])}${field('Unique payment reference','reference','text','','maxlength="160"')}</div><p class="notice">This records an already-received payment. It does not transfer money or charge the buyer.</p>`,'payment');
}
export function contractForm(id) {
  const c=app.data.contracts.find(c=>c.id===id),cohort=app.data.cohorts.find(x=>x.id===(c?.cohortId||app.cohortId))||app.data.cohorts[0];
  if(!cohort)return modal('Create a cohort first',empty('No cohort available'));
  modal('Compose a program agreement',`${hidden('id',id||'')}${select('Program / buyer','cohortId',cohortOptions(),c?.cohortId||cohort.id)}${field('Agreement title','title','text',c?.title||`Group coaching / ${cohort.name}`)}${field('Total investment ($)','amount','number',(c?.amount??cohort.price*cohort.capacity)/100,'min="0" step="0.01"')}${textarea('Program scope and agreed terms','terms',c?.terms||'Program scope: Six 90-minute group coaching sessions over twelve weeks.\n\nThe program includes a baseline, working sessions, and a closing practice plan.\n\nAdditional terms and delivery arrangements are to be agreed by the coach and buyer before execution.',true)}<p class="help">Company, cohort, dates, and price are included in the generated agreement. The buyer can review and acknowledge this local draft. DocuSign signing is not connected.</p>`,'contract');
}
export function contractDetail(id) {
  const c=app.data.contracts.find(c=>c.id===id);
  modal(c.title,`<article class="print-document"><div class="eyebrow">GoCoach · Program agreement</div><h3>${e(c.title)}</h3><dl class="detail-list"><div><dt>Buyer</dt><dd>${e(c.company)}</dd></div><div><dt>Program</dt><dd>${e(c.programName)}</dd></div><div><dt>Dates</dt><dd>${dt(c.startDate)} — ${dt(c.endDate)}</dd></div><div><dt>Investment</dt><dd>${money(c.amount)}</dd></div></dl><section class="material-block"><h3>Scope & terms</h3><p class="pre-wrap">${e(c.terms)}</p></section>${c.acknowledgement?`<div class="notice"><p>Locally acknowledged by ${e(c.acknowledgement.name)} on ${dt(c.acknowledgement.at,{hour:'numeric',minute:'2-digit'})}.<br/><small>Document fingerprint: ${e(c.contentHash)}</small></p></div>`:''}<p class="help">Local prototype record. Not a DocuSign envelope or verified electronic signature.</p></article><div class="card-actions">${button('Print / save as PDF','print','','primary')}${isCoach()&&c.status==='draft'?button('Request buyer review','request-contract-review',id):''}${isBuyer()&&c.status==='in-review'?button('Acknowledge review','acknowledge-contract',id):''}</div>`);
}
export function acknowledgeForm(id) {
  const c=app.data.contracts.find(c=>c.id===id);
  modal('Acknowledge agreement review',`${hidden('id',id)}<p>${e(c.title)}</p>${field('Your full name','name','text',app.data.user.name)}${check('I have reviewed this agreement and understand that this is a local prototype acknowledgement, not a DocuSign signature.','consent',false,true)}`,'acknowledgement');
}
export function messageForm(id) {
  const people=app.data.users.filter(user=>user.id!==app.data.user.id&&(isCoach()||user.role==='coach'||(isBuyer()?user.role==='participant':user.role==='buyer')));
  modal('Start a conversation',`${select('To','recipientId',people.map(user=>[user.id,`${user.name} · ${user.role}`]),id||'')}${textarea('Your message','message','',true,'maxlength="5000"')}<p class="help">Delivered inside this workspace. No email is sent.</p>`,'message');
}
