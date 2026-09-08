import { api } from './ui.js';
const form=document.getElementById('newsletter-form');
form?.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!form.reportValidity()||form.dataset.busy)return;
  form.dataset.busy='true';
  const button=form.querySelector('button'),status=document.getElementById('newsletter-status');
  button.disabled=true;status.textContent='Saving your preference…';
  try{
    const result=await api('public/subscribe',{email:form.elements.email.value,consent:form.elements.consent.checked});
    status.textContent=result.message;form.reset();
    if(result.unsubscribeToken){
      const undo=document.createElement('button');undo.type='button';undo.className='text-link';undo.textContent='Undo subscription';
      undo.addEventListener('click',async()=>{undo.disabled=true;try{const response=await api('public/unsubscribe',{token:result.unsubscribeToken});status.textContent=response.message;undo.remove();}catch(error){status.textContent=error.message;undo.disabled=false;}});
      form.querySelector('.text-link')?.remove();form.append(undo);
    }
  }catch(error){status.textContent=error.message;}
  finally{delete form.dataset.busy;button.disabled=false;}
});
