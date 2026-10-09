import { createHash } from 'node:crypto'

export const nativeLibraryVersion = '0.18.1'
export const nativeLibraryHash = '7f651063487849c79a8cdedc3aa6bd04c6b0c717ee63959116f1f12dbc0a51b8'
export function patchNativeActions(source, version, bridgePath) {
  if (version !== nativeLibraryVersion || createHash('sha256').update(source).digest('hex') !== nativeLibraryHash) throw new Error('The pinned Excalidraw native action bridge does not match the installed library')
  const patches = [
    ['C(this,"toggleSidebar",({name:t,tab:r,force:n})=>{let i;', 'C(this,"toggleSidebar",({name:t,tab:r,force:n})=>{let __valleyOpen=n??!(this.state.openSidebar?.name===t&&this.state.openSidebar?.tab===r);if(t===pt.name&&r===pt.defaultTab&&__valleyRouteControl(this,"toolbar","library",__valleyOpen))return __valleyOpen;let i;'],
    ['perform:()=>{I.openSidebar?r({openSidebar:null}):r({openSidebar:{name:pt.name,tab:pt.defaultTab}})}', 'perform:()=>{if(__valleyRouteControl(__valleyApp,"toolbar","library",!I.openSidebar))return;I.openSidebar?r({openSidebar:null}):r({openSidebar:{name:pt.name,tab:pt.defaultTab}})}'],
    ['let l=pe(),s=Tr(Ja);E0(', 'let l=pe(),s=Tr(Ja),__valleySidebarApp=He();E0('],
    ['c.current.onCloseRequest=()=>{l({openSidebar:null})}', 'c.current.onCloseRequest=()=>{if(e===pt.name&&__valleySidebarApp.state.openSidebar?.tab===pt.defaultTab&&__valleyRouteControl(__valleySidebarApp,"toolbar","library",!1))return;l({openSidebar:null})}'],
    ['document.querySelector(".Dialog")||l({openSidebar:null})},[l])', 'document.querySelector(".Dialog")||(e===pt.name&&__valleySidebarApp.state.openSidebar?.tab===pt.defaultTab&&__valleyRouteControl(__valleySidebarApp,"toolbar","library",!1))||l({openSidebar:null})},[l])'],
    ['await Jx(n,r.files,t)}catch(i){return{captureUpdate', 'await Jx(n,r.files,t,__valleyExportGuard(r))}catch(i){if(i?.outcome)throw i;return{captureUpdate'],
    ['try{yr(Qm(n))}catch{throw new Error(g("errors.copyToSystemClipboardFailed"))}', 'try{await yr(Qm(n),void 0,__valleyExportGuard(r))}catch(error){if(error?.outcome)throw error;throw new Error(g("errors.copyToSystemClipboardFailed"))}'],
    ['try{await yr(p)}catch{throw new Error(g("errors.copyToSystemClipboardFailed"))}', 'try{await yr(p,void 0,__valleyBeforeExport)}catch(error){if(error?.outcome)throw error;throw new Error(g("errors.copyToSystemClipboardFailed"))}'],
    ['Ss(i.id,i.type)),{appState:{toast:{message:g("toast.elementLinkCopied")', 'Ss(i.id,i.type),void 0,__valleyExportGuard(r)),{appState:{toast:{message:g("toast.elementLinkCopied")'],
    ['catch(i){console.error(i)}return{appState:o,elements:e,app:r,captureUpdate:L.EVENTUALLY}', 'catch(i){if(i?.outcome)throw i;console.error(i);throw Object.assign(i,{outcome:"unknown",outcomeUnknown:!0,retryable:!1})}return{appState:o,elements:e,app:r,captureUpdate:L.EVENTUALLY}'],
    ['ev=async(e,o,t,r)=>', 'ev=async(e,o,t,r,__valleyBeforeExport)=>'],
    ['name:r,fileHandle:a,exportingFrame:c}),{fileHandle:a}', 'name:r,fileHandle:a,exportingFrame:c,__valleyBeforeExport}),{fileHandle:a}'],
    ['mimeTypes:[ra.svg],fileHandle:s});', 'mimeTypes:[ra.svg],fileHandle:s,__valleyBeforeEffect:__valleyBeforeExport});'],
    ['mimeTypes:[ra.png],fileHandle:s})', 'mimeTypes:[ra.png],fileHandle:s,__valleyBeforeEffect:__valleyBeforeExport})'],
    ['await ev(e,o,r.files,r.getName()):await ws(e,o,r.files,r.getName())', 'await ev(e,o,r.files,r.getName(),__valleyExportGuard(r)):await ws(e,o,r.files,r.getName(),__valleyExportGuard(r))'],
    ['await ws(e,{...o,fileHandle:null},r.files,r.getName())', 'await ws(e,{...o,fileHandle:null},r.files,r.getName(),__valleyExportGuard(r))'],
    ['return i?.name!=="AbortError"?console.error(i):console.warn(i),{captureUpdate:L.EVENTUALLY}', 'if(i?.outcome==="not-applied")throw i;if(i?.name==="AbortError")return!1;throw Object.assign(i,{outcome:"unknown",outcomeUnknown:!0,retryable:!1})'],
    ['return n?.name!=="AbortError"?console.error(n):console.warn(n),{captureUpdate:L.EVENTUALLY}', 'if(n?.outcome==="not-applied")throw n;if(n?.name==="AbortError")return!1;throw Object.assign(n,{outcome:"unknown",outcomeUnknown:!0,retryable:!1})'],
    ['Bx(M).catch(_l).catch(N=>{e({errorMessage:N.message})})', 'return Bx(M,__valleyExportGuard(__valleyApp)).catch(error=>{if(error?.outcome==="not-applied"||error?.name==="AbortError")throw error;return _l(error)}).catch(N=>{if(N?.outcome==="not-applied"||N?.name==="AbortError")throw N;e({errorMessage:N.message});throw Object.assign(N,{outcome:"unknown",outcomeUnknown:!0,retryable:!1})})'],
    ['exportingFrame:c=null})=>{if(o.length===0)', 'exportingFrame:c=null,__valleyBeforeExport=async()=>{}})=>{if(o.length===0)'],
    ['{...o,exportingFrame:i,name:r.getName()});let a=r.scene', '{...o,exportingFrame:i,name:r.getName(),__valleyBeforeExport:__valleyExportGuard(r)});let a=r.scene'],
    ['{...o,exportingFrame:a,name:r.getName()}),{appState:{...o,toast', '{...o,exportingFrame:a,name:r.getName(),__valleyBeforeExport:__valleyExportGuard(r)}),{appState:{...o,toast'],
    ['else if(e==="clipboard")try{let d=jo(m);await Qx(d)}catch', 'else if(e==="clipboard")try{if(__valleyBeforeExport.writeText)throw Object.assign(new Error("The host clipboard accepts text only; copy the drawing as SVG instead."),{code:"CLIPBOARD_UNSUPPORTED",outcome:"not-applied",retryable:!1,effectRefused:!0});let d=await jo(m);await __valleyBeforeExport(d);await Qx(d)}catch'],
    ['await Qx(d)}catch(d){throw console.warn(d)', 'await Qx(d,__valleyBeforeExport)}catch(d){if(d?.outcome)throw d;throw console.warn(d)'],
    ['return console.error(a),{appState:{errorMessage:a.message},captureUpdate:L.EVENTUALLY}', 'if(a?.outcome)throw a;return console.error(a),{appState:{errorMessage:a.message},captureUpdate:L.EVENTUALLY}'],
    ['return console.error(l),{appState:{...o,errorMessage:l.message},captureUpdate:L.EVENTUALLY}', 'if(l?.outcome)throw l;return console.error(l),{appState:{...o,errorMessage:l.message},captureUpdate:L.EVENTUALLY}'],
    ['C(this,"toggleLock",(t="ui")=>{this.state', 'C(this,"toggleLock",(t="ui")=>{if(__valleyRouteControl(this,"toolbar","lock",null))return;this.state'],
    ['C(this,"togglePenMode",t=>{this.setState', 'C(this,"togglePenMode",t=>{if(__valleyRouteControl(this,"toolbar","pen",t??!this.state.penMode))return;this.setState'],
    ['d=yu(h=>{(async(b,x)=>{le("element","addToLibrary","ui");', 'd=yu(h=>{if(__valleyRouteAction(__valleyPendingApp,"addToLibrary",null))return;(async(b,x)=>{le("element","addToLibrary","ui");'],
    ['id:a,theme:l,selectedItems:s,onSelectItems:c})=>{let[m]=ce(Cn)', 'id:a,theme:l,selectedItems:s,onSelectItems:c})=>{let __valleyPendingApp=He();let[m]=ce(Cn)'],
    ['.catch(i=>({captureUpdate:L.EVENTUALLY,appState:{...o,errorMessage:i.message}}))},label:"labels.addToLibrary"', '.catch(i=>{if(i?.outcome==="not-applied")throw i;return{captureUpdate:L.EVENTUALLY,appState:{...o,errorMessage:i.message}}})},label:"labels.addToLibrary"'],
    ['registerAction:p=>{this.actionManager.registerAction(p)},', 'registerAction:p=>{this.actionManager.registerAction(p)},__valleyNative:__valleyCreateNativeBridge(this,{drag:FE,transform:DE,clone:xr,textLayout:ox,container:Qt,newElement:q,bound:Jt,bounds:Se}),'],
    ['var Fe=e=>o=>{H1(e,o)},Ad=e=>', 'var Fe=e=>o=>{return H1(e,o)},Ad=e=>'],
    [',this.currLibraryItems=Ya(await o),r(this.currLibraryItems)', ';let next=await o;await __valleyBeforeNativeEffect(this.app,{kind:"library-update",items:next});this.currLibraryItems=Ya(next);__valleyRecordLibrary(this.app);r(this.currLibraryItems)'],
    ['if(Gn(i))i.then(a=>o(a));else return o(i)', 'if(Gn(i))return i.then(a=>o(a));else return o(i)'],
    ['try{r.pasteFromClipboard(jx({types:n}))}catch(i)', 'try{await __valleyBeforeNativeEffect(r);await r.pasteFromClipboard(jx({types:n}));__valleyRecordScene(r)}catch(i)'],
    ['if(m.errorMessage)this.setState', 'await __valleyBeforeNativeEffect(this);if(m.errorMessage)this.setState'],
    ['return console.error(i),{captureUpdate:L.EVENTUALLY,appState:{...o,errorMessage:g("errors.asyncPasteFailedOnParse")}}', 'if(i?.outcome==="not-applied")throw i;return console.error(i),{captureUpdate:L.EVENTUALLY,appState:{...o,errorMessage:g("errors.asyncPasteFailedOnParse")}}'],
    ['perform:(e,o,t,r)=>(_i.perform(e,o,t,r),_a.perform(e,o,null,r))', 'perform:async(e,o,t,r)=>{let copied=await _i.perform(e,o,t,r);if(copied?.appState?.errorMessage)return copied;await __valleyBeforeNativeEffect(r);return _a.perform(e,o,null,r)}'],
    ['name:"copyText",label:"labels.copyText",trackEvent:{category:"element"},perform:(e,o,t,r)=>', 'name:"copyText",label:"labels.copyText",trackEvent:{category:"element"},perform:async(e,o,t,r)=>'],
    ['s=c=>{Nu(n,"ui",l,a,this.app,c),', 's=c=>{if(__valleyRouteAction(this.app,n.name,c))return;Nu(n,"ui",l,a,this.app,c),'],
    ['return Nu(n,"keyboard",a,i,this.app,null),o.preventDefault(),o.stopPropagation(),this.updater(r[0].perform(i,a,l,this.app)),!0', 'o.preventDefault();o.stopPropagation();if(__valleyRouteAction(this.app,n.name,null))return!0;return Nu(n,"keyboard",a,i,this.app,null),this.updater(r[0].perform(i,a,l,this.app)),!0'],
    ['executeAction(o,t="api",r=null){let n=', 'executeAction(o,t="api",r=null){if(__valleyRouteAction(this.app,o.name,r))return;let n='],
    ['C(this,"setActiveTool",t=>{if(!this.isToolSupported(t.type))', 'C(this,"setActiveTool",t=>{if(__valleyRouteTool(this,t))return;if(!this.isToolSupported(t.type))'],
    ['Nu(o,t,i,n,this.app,r),this.updater(o.perform(n,i,r,this.app))', 'Nu(o,t,i,n,this.app,r);return this.updater(o.perform(n,i,r,this.app))'],
    ['[i,a]=uw([]),l=gw(()=>e.library,[e.library])', '[i,__valleySelect]=uw([]),a=value=>{if(!__valleyRouteControl(e,"library-selection","select",value))__valleySelect(value)},l=gw(()=>e.library,[e.library])'],
    ['c=yu(d=>{o(_c(d))},[o])', 'c=yu(d=>{if(__valleyRouteControl(e,"library-selection","insert",d))return;o(_c(d))},[o])'],
    ['m=yu(()=>{n({selectedElementIds:{},selectedGroupIds:{},activeEmbeddable:null})},[n]);return Mr(QS,', 'm=yu(()=>{n({selectedElementIds:{},selectedGroupIds:{},activeEmbeddable:null})},[n]);__valleyUseNativeControl(e,"library-selection",()=>({selectedIds:i,itemsRevision:__valleyLibraryRevision(e)}),{select:value=>a(value),insert:value=>c(value)});return Mr(QS,'],
    ['[x,T]=hu(!1),[E,w]=hu(null)', '[x,__valleyPublishOpen]=hu(!1),T=value=>{if(value&&!__valleyRouteControl(__valleyApp,"library-menu","publish",null)||!value)__valleyPublishOpen(value)},[E,w]=hu(null)'],
    ['_=async()=>{try{await t.updateLibrary({libraryItems:bs({description:"Excalidraw library files"})', '_=async()=>{if(__valleyRouteControl(__valleyApp,"library-menu","import",null))return;try{await t.updateLibrary({libraryItems:bs({description:"Excalidraw library files"})'],
    ['k=async()=>{let M=h?f:await t.getLatestLibrary();', 'k=async()=>{if(__valleyRouteControl(__valleyApp,"library-menu","export",null))return;let M=h?f:await t.getLatestLibrary();'],
    ['onConfirm:()=>{o.length?r():n(),u(!1)}', 'onConfirm:()=>{if(__valleyRouteControl(__valleyApp,"library-menu","remove",null))return;o.length?r():n(),u(!1)}'],
    ['MS=({setAppState:e,selectedItems:o,library:t,onRemoveFromLibrary:r,resetLibrary:n,onSelectItems:i,appState:a,className:l})=>{let[s]', 'MS=({setAppState:e,selectedItems:o,library:t,onRemoveFromLibrary:r,resetLibrary:n,onSelectItems:i,appState:a,className:l})=>{let __valleyApp=He();__valleyUseNativeControl(__valleyApp,"library-menu",()=>({selectedIds:o,publishOpen:x,confirmRemove:p,itemsRevision:__valleyLibraryRevision(__valleyApp)}),{remove:()=>{o.length?r():n();u(!1)},import:()=>_(),export:()=>k(),publish:()=>T(!0),cancel:()=>T(!1)});let[s]'],
    ['bS=({onClose:e,libraryItems:o,appState:t,onSuccess:r,onError:n,updateItemsInStorage:i,onRemove:a})=>{let[l,s]', 'bS=({onClose:e,libraryItems:o,appState:t,onSuccess:r,onError:n,updateItemsInStorage:i,onRemove:a})=>{let __valleyApp=He();__valleyUseNativeControl(__valleyApp,"library-publish",()=>({draft:l,items:d.map(item=>({id:item.id,name:item.name||"",error:item.error||""})),busy:c}),{patch:value=>{s({...l,...value.fields});p(d.map(item=>value.names&&item.id in value.names?{...item,name:value.names[item.id]}:item))},confirm:()=>h({preventDefault(){}}),cancel:()=>b()});let[l,s]'],
    [',fetch(`${v.VITE_APP_LIBRARY_BACKEND}/submit`,{method:"post",body:M})', ';try{await __valleyBeforeNativeEffect(__valleyApp,{kind:"library-publish",library:_,fields:l,preview:I})}catch(error){m(!1);throw error}__valleyRecordPublish(__valleyApp,"unknown","");return fetch(`${v.VITE_APP_LIBRARY_BACKEND}/submit`,{method:"post",body:M})'],
    ['u=E=>{s({...l,[E.target.name]:E.target.value})},h=async E=>{E.preventDefault(),m(!0);', 'u=E=>{let fields={...l,[E.target.name]:E.target.value};if(!__valleyRouteControl(__valleyApp,"library-publish","patch",{fields,names:{}}))s(fields)},h=async E=>{E.preventDefault();if(__valleyRouteControl(__valleyApp,"library-publish","confirm",null))return;m(!0);'],
    ['onChange:(I,_)=>{let k=d.slice();k[_].name=I,p(k)}', 'onChange:(I,_)=>{if(__valleyRouteControl(__valleyApp,"library-publish","patch",{fields:l,names:{[d[_].id]:I}}))return;let k=d.slice();k[_].name=I,p(k)}'],
    ['b=gS(()=>{i(d),ro.set(cr.PUBLISH_LIBRARY,l),e()}', 'b=gS(()=>{if(__valleyRouteControl(__valleyApp,"library-publish","cancel",null))return;i(d),ro.set(cr.PUBLISH_LIBRARY,l),e()}'],
    ['ro.delete(cr.PUBLISH_LIBRARY),r({url:G,authorName:l.authorName,items:d})', 'ro.delete(cr.PUBLISH_LIBRARY),__valleyRecordPublish(__valleyApp,"server-receipt",G),r({url:G,authorName:l.authorName,items:d})'],
    ['let c=()=>{hd({app:s,data:l,text:o,shouldSaveMermaidDataToStorage:!0})};return o1(WA,', 'let c=()=>{if(__valleyRouteControl(s,"mermaid","insert",null))return;hd({app:s,data:l,text:o,shouldSaveMermaidDataToStorage:!0})};__valleyUseNativeControl(s,"mermaid",()=>({text:o,renderedText:r,error:n?String(n):"",elements:l.current.elements.length,ready:e.loaded}),{patch:value=>t(value),insert:()=>c()});return o1(WA,'],
    ['input:o,placeholder:"Write Mermaid diagram defintion here...",onChange:m=>t(m.target.value)', 'input:o,placeholder:"Write Mermaid diagram defintion here...",onChange:m=>{if(!__valleyRouteControl(s,"mermaid","patch",m.target.value))t(m.target.value)}'],
    ['let r=n=>{kw(n)&&(n.preventDefault(),n.stopPropagation(),t(i=>', 'let r=n=>{kw(n)&&(n.preventDefault(),n.stopPropagation(),__valleyRouteControl(__valleyApp,"command-palette","toggle",null)||t(i=>'],
    ['C(this,"setOpenDialog",t=>{this.setState({openDialog:t})', 'C(this,"setOpenDialog",t=>{if((t?.name==="ttd"&&t.tab==="mermaid"||t===null&&this.state.openDialog?.name==="ttd"&&this.state.openDialog?.tab==="mermaid")&&__valleyRouteControl(this,"extra-tools",t===null?"close":"mermaid",null))return;this.setState({openDialog:t})'],
    ['VK=Object.assign(e=>{let o=ve(),t=pe();return Kc(', 'VK=Object.assign(e=>{let o=ve(),t=pe(),__valleyApp=He();__valleyUseNativeControl(__valleyApp,"command-palette",()=>({open:o.openDialog?.name==="commandPalette"}),{toggle:()=>t(i=>({openDialog:i.openDialog?.name==="commandPalette"?null:{name:"commandPalette"}}))});return Kc('],
    ['let[n,i]=Ck(!1),a=e.type==="frame"', 'let[n,__valleySetTools]=Ck(!1),i=value=>{if(!__valleyRouteControl(t,"extra-tools","set",value))__valleySetTools(value)},a=e.type==="frame"'],
    ['s=e.type==="embeddable",{TTDDialogTriggerTunnel:c}=_e();return et(nr,', 's=e.type==="embeddable",{TTDDialogTriggerTunnel:c}=_e();__valleyUseNativeControl(t,"extra-tools",()=>({open:n}),{set:value=>i(value),mermaid:()=>t.setOpenDialog({name:"ttd",tab:"mermaid"}),close:()=>t.setOpenDialog(null)});return et(nr,'],
    ['n.current={elements:Yi(c,{regenerateIds:!0}),files:m}', 'n.current={elements:Yi(c,{regenerateIds:!0}),files:m,definition:""}'],
    ['i.replaceChildren(d)}catch(l)', 'i.replaceChildren(d),n.current.definition=t}catch(l)'],
    ['text:o,renderedText:r,error:n?String(n):"",elements:l.current.elements.length', 'text:o,renderedText:r,parsedText:l.current.definition||"",error:n?String(n):"",elements:l.current.elements.length'],
    [',r.type==="image"&&this.onImageAction({insertOnCanvasDirectly:(t.type==="image"&&t.insertOnCanvasDirectly)??!1}),this.setState', ';let __valleyImageRequest=r.type==="image"?this.onImageAction({insertOnCanvasDirectly:(t.type==="image"&&t.insertOnCanvasDirectly)??!1}):void 0;this.setState'],
    ['multiElement:null,...i}:{...n,activeTool:r,...i}})});C(this,"setOpenDialog"', 'multiElement:null,...i}:{...n,activeTool:r,...i}});return __valleyImageRequest});C(this,"setOpenDialog"'],
    ['l=await bs({description:"Image",extensions:Object.keys(ra)}),s=this.createImageElement', 'l=await bs({description:"Image",extensions:Object.keys(ra)});await __valleyBeforeNativeEffect(this);let s=this.createImageElement'],
    ['t?(this.insertImageElement(s,l),this.initializeImageDimensions(s),this.setState({selectedElementIds:Ee({[s.id]:!0},this.state)},()=>{this.actionManager.executeAction(Ht)})):this.setState({pendingImageElementId:s.id},()=>{this.insertImageElement(s,l,!0)})', 'if(t){await this.insertImageElement(s,l);this.initializeImageDimensions(s);this.setState({selectedElementIds:Ee({[s.id]:!0},this.state)},()=>{this.actionManager.executeAction(Ht)})}else{this.setState({pendingImageElementId:s.id});await this.insertImageElement(s,l,!0)}'],
    ['this.scene.insertElement(t);try{return await this.initializeImage', 'await __valleyBeforeNativeEffect(this);this.scene.insertElement(t);__valleyRecordScene(this);try{return await this.initializeImage'],
    ['let s=this.files[a]?.dataURL||await vs(t),c=P(r,{fileId:a},!1);', 'let s=this.files[a]?.dataURL||await vs(t);await __valleyBeforeNativeEffect(this);let c=P(r,{fileId:a},!1);']
  ]
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error(`The pinned Excalidraw native action bridge is ambiguous: ${before}`)
    source = source.replace(before, after)
  }
  return `import { createNativeBridge as __valleyCreateNativeBridge, useNativeControl as __valleyUseNativeControl, nativeExportGuard as __valleyExportGuard, beforeNativeEffect as __valleyBeforeNativeEffect, recordNativePublish as __valleyRecordPublish, recordNativeScene as __valleyRecordScene, recordNativeLibrary as __valleyRecordLibrary, nativeLibraryRevision as __valleyLibraryRevision, routeNativeAction as __valleyRouteAction, routeNativeTool as __valleyRouteTool, routeNativeControl as __valleyRouteControl } from ${JSON.stringify(bridgePath)};\n${source}`
}

export const nativeEffectSources = {
  'chunk-K2UTITRG.js': { version: '0.18.1', hash: '72b54e8e9b3c17c69f1dd5e40203bfaed62313bc611b86ecb8a1625a12562e51' },
  'file-save-745eba88.js': { version: '0.29.1', hash: 'bb6dca08cf5c225cdc67c043aa2c2df67ed638aa1c3b2b72ef071492711bfa80' },
  'file-save-3189631c.js': { version: '0.29.1', hash: '3453a5d0851d7c16c8942ad8f0411ab796c3bd7839c992ba3448591f249733ca' }
}
export function patchNativeEffects(source, name, version) {
  const pinned = nativeEffectSources[name]
  if (!pinned || version !== pinned.version || createHash('sha256').update(source).digest('hex') !== pinned.hash) throw new Error('The pinned Excalidraw native effect bridge does not match the installed library')
  const patches = name === 'chunk-K2UTITRG.js' ? [
    ['Bp=async e=>{try{', 'Bp=async(e,__valleyBeforeEffect)=>{if(__valleyBeforeEffect)await __valleyBeforeEffect(await e);try{'],
    ['catch(t){if(Fo(e))await navigator.clipboard.write', 'catch(t){if(__valleyBeforeEffect)throw Object.assign(t,{outcome:"unknown",outcomeUnknown:!0,retryable:!1});if(Fo(e))await navigator.clipboard.write'],
    ['Np=async(e,t,n)=>{await hs(W7({elements:e,files:t}),n)}', 'Np=async(e,t,n,__valleyBeforeEffect)=>{await hs(W7({elements:e,files:t}),n,__valleyBeforeEffect)}'],
    ['hs=async(e,t)=>{if(k7)try{await navigator.clipboard.writeText(e||"");return}catch(n){console.error(n)}', 'hs=async(e,t,__valleyBeforeEffect)=>{if(__valleyBeforeEffect){await __valleyBeforeEffect(e||"");if(__valleyBeforeEffect.writeText){await __valleyBeforeEffect.writeText(e||"");return}}if(k7)try{await navigator.clipboard.writeText(e||"");return}catch(n){if(__valleyBeforeEffect)throw Object.assign(n,{outcome:"unknown",outcomeUnknown:!0,retryable:!1});console.error(n)}'],
    ['mimeTypes:t.mimeTypes},t.fileHandle)', 'mimeTypes:t.mimeTypes,__valleyBeforeEffect:t.__valleyBeforeEffect},t.fileHandle)'],
    ['hO=async(e,t,n,r=t.name||Zs)=>', 'hO=async(e,t,n,r=t.name||Zs,__valleyBeforeEffect)=>'],
    ['fileHandle:W2(t.fileHandle)?null:t.fileHandle})', 'fileHandle:W2(t.fileHandle)?null:t.fileHandle,__valleyBeforeEffect})'],
    ['IO=async e=>{let t=p7(e);', 'IO=async(e,__valleyBeforeEffect)=>{let t=p7(e);'],
    ['extension:"excalidrawlib",description:"Excalidraw library file"})', 'extension:"excalidrawlib",description:"Excalidraw library file",__valleyBeforeEffect})']
  ] : name === 'file-save-745eba88.js' ? [
    ['!a&&n&&n();const l=await r.createWritable();', '!a&&n&&n();const __valleyGuard=t[0].__valleyBeforeEffect;let __valleyBlob;if(__valleyGuard){__valleyBlob=await e;if("body"in __valleyBlob)__valleyBlob=await __valleyBlob.blob();await __valleyGuard(__valleyBlob);e=__valleyBlob}const l=await r.createWritable();if(__valleyGuard)try{await __valleyGuard(__valleyBlob)}catch(error){try{await l.abort()}catch{throw Object.assign(error,{outcome:"unknown",outcomeUnknown:true,retryable:false})}throw error}']
  ] : [
    ['n.href=URL.createObjectURL(await a);', 'a=await a,t.__valleyBeforeEffect&&await t.__valleyBeforeEffect(a),n.href=URL.createObjectURL(a);']
  ]
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error('The pinned Excalidraw native effect bridge is ambiguous')
    source = source.replace(before, after)
  }
  return source
}
