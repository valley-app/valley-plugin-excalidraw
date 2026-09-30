import assert from 'node:assert/strict'
import path from 'node:path'
import { readdir } from 'node:fs/promises'

export default async function () {
  const root = path.resolve(import.meta.dirname, '../..')
  const assets = { '/assets/island.js': path.join(root, 'runtime/assets/island.js') }
  for (const file of await readdir(path.join(root, 'runtime/assets/fonts'), { recursive: true })) {
    if (file.endsWith('.woff2') || file.endsWith('.woff2.js')) assets[`/assets/fonts/${file}`] = path.join(root, 'runtime/assets/fonts', file)
  }
  return {
    assets,
    hostSetup: `
      window.fixtureDrawingLanguage='de';const drawingLanguageListeners=new Set();
      api.ui.language=()=>window.fixtureDrawingLanguage;
      api.ui.onLanguageChanged=listener=>{drawingLanguageListeners.add(listener);return()=>drawingLanguageListeners.delete(listener)};
      window.fixtureSetDrawingLanguage=language=>{window.fixtureDrawingLanguage=language;drawingLanguageListeners.forEach(listener=>listener())};
      const drawingScene={elements:[{id:'meadow',type:'rectangle',x:40,y:40,width:120,height:80,angle:0,strokeColor:'#1b1b1f',backgroundColor:'transparent',fillStyle:'solid',strokeWidth:1,strokeStyle:'solid',roughness:0,opacity:100,groupIds:[],frameId:null,roundness:null,seed:1,version:1,versionNonce:1,isDeleted:false,boundElements:null,updated:1,link:null,locked:false,index:'a0'}],appState:{viewBackgroundColor:'#ffffff'},files:{}};
      api.vault={readFile:async()=>JSON.stringify(drawingScene)};
      api.workspace.openFile=async path=>{window.fixtureOpenedDrawing=path};
      api.markdown.registerCodeBlockRenderer=(language,render)=>{
        if(language!=='excalidraw')return()=>{};
        window.fixtureMountDrawingFence=()=>{const host=document.createElement('div');host.id='drawing-fence-host';Object.assign(host.style,{position:'fixed',left:'40px',top:'180px',width:'600px',zIndex:'1000'});document.body.appendChild(host);window.fixtureDisposeDrawingFence=render('file: [[Meadow.excalidraw]]\\nheight: 240',host,{});};
        return()=>{window.fixtureDisposeDrawingFence?.();document.getElementById('drawing-fence-host')?.remove()};
      };
    `,
    entry: `
      import { initRuntime } from ${JSON.stringify(path.join(root, 'src/runtime.ts'))};
      import { mountEditor, renderPreviewSvg } from ${JSON.stringify(path.join(root, 'src/island.ts'))};
      import { registerExcalidrawFence } from ${JSON.stringify(path.join(root, 'src/fence.tsx'))};
      import { injectStyles } from ${JSON.stringify(path.join(root, 'src/styles.ts'))};
      export function register(api){
        initRuntime(api);const R=api.React;const removeStyles=injectStyles();const removeFence=registerExcalidrawFence();
        const element={id:'meadow',type:'rectangle',x:40,y:40,width:120,height:80,angle:0,strokeColor:'#1b1b1f',backgroundColor:'transparent',fillStyle:'solid',strokeWidth:1,strokeStyle:'solid',roughness:0,opacity:100,groupIds:[],frameId:null,roundness:null,seed:1,version:1,versionNonce:1,isDeleted:false,boundElements:null,updated:1,link:null,locked:false,index:'a0'};
        function Drawing(){const ref=R.useRef(null);const preview=R.useRef(null);const editor=R.useRef(null);R.useEffect(()=>{let disposed=false;void mountEditor(ref.current,{initialData:{elements:[element],appState:{},files:{}},onChange(){},onLinkOpen(){}}).then(value=>{if(disposed)value.unmount();else{editor.current=value;ref.current.dataset.ready='true'}});void renderPreviewSvg({elements:[element],appState:{},files:{}}).then(svg=>{if(!disposed&&svg)preview.current.appendChild(svg)});return()=>{disposed=true;editor.current?.unmount()}},[]);return R.createElement('div',null,R.createElement('button',{id:'drawing-update',onClick(){editor.current.updateScene({elements:[{...element,width:180,backgroundColor:'#ff0000'}]});editor.current.restoreView({zoom:1.5});ref.current.dataset.serialized=editor.current.serialize()}},'Update drawing'),R.createElement('button',{id:'drawing-snapshot',onClick(){ref.current.dataset.serialized=editor.current.serialize();ref.current.dataset.view=JSON.stringify(editor.current.getView())}},'Inspect drawing'),R.createElement('div',{id:'drawing-root',ref,style:{width:'600px',height:'350px'}}),R.createElement('div',{id:'drawing-preview',ref:preview}))}
        api.registerView('fixture.drawing',Drawing);
        return()=>{removeFence();removeStyles()};
      }
    `,
    run: `
      let drawingFrame;
      for(let i=0;i<300;i++){
        for(const frame of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url.endsWith('/surface.html'))){if(await frame.executeJavaScript('!!document.querySelector("#drawing-root[data-ready] .excalidraw canvas")')){drawingFrame=frame;report.drawingMounted=true;report.drawingRuntime=await frame.executeJavaScript('typeof window.valleyExcalidrawIsland?.mountEditor');break}}
        if(report.drawingMounted)break;await wait(20)
      }
      if(!report.drawingMounted)throw Error('Drawing island did not mount in Surface realm');
      report.drawingInitialLanguage=await drawingFrame.executeJavaScript('document.querySelector("#drawing-root [data-testid=button-undo]")?.getAttribute("aria-label")');
      await drawingFrame.executeJavaScript('window.fixtureDrawingCanvas=document.querySelector("#drawing-root canvas");undefined');
      const beforeDrawing=await drawingFrame.executeJavaScript('[...document.querySelectorAll("#drawing-root canvas")].map(canvas=>canvas.toDataURL()).join("")');
      await drawingFrame.executeJavaScript('document.getElementById("drawing-update").click()');
      for(let i=0;i<150;i++){report.drawingChanged=await drawingFrame.executeJavaScript('[...document.querySelectorAll("#drawing-root canvas")].map(canvas=>canvas.toDataURL()).join("")')!==beforeDrawing;report.drawingPreview=await drawingFrame.executeJavaScript('!!document.querySelector("#drawing-preview svg path")');if(report.drawingChanged&&report.drawingPreview)break;await wait(20)}
      report.drawingScene=await drawingFrame.executeJavaScript('JSON.parse(document.getElementById("drawing-root").dataset.serialized).elements.map(({id,width})=>({id,width}))');
      await drawingFrame.executeJavaScript('document.getElementById("drawing-snapshot").click()');
      const drawingBeforeLanguages=await drawingFrame.executeJavaScript('({serialized:document.getElementById("drawing-root").dataset.serialized,view:document.getElementById("drawing-root").dataset.view})');
      report.drawingLanguages=[];
      for(const [language,label] of [['en','Undo'],['es','Deshacer'],['fr','Annuler'],['zh-CN','撤销'],['de','Rückgängig machen'],['unsupported','Undo']]){
        await win.webContents.executeJavaScript('window.fixtureSetDrawingLanguage('+JSON.stringify(language)+')');
        let actual;
        for(let i=0;i<150;i++){actual=await drawingFrame.executeJavaScript('document.querySelector("#drawing-root [data-testid=button-undo]")?.getAttribute("aria-label")');if(actual===label)break;await wait(20)}
        await drawingFrame.executeJavaScript('document.getElementById("drawing-snapshot").click()');
        const current=await drawingFrame.executeJavaScript('({sameCanvas:document.querySelector("#drawing-root canvas")===window.fixtureDrawingCanvas,serialized:document.getElementById("drawing-root").dataset.serialized,view:document.getElementById("drawing-root").dataset.view})');
        report.drawingLanguages.push({language,label:actual,sameCanvas:current.sameCanvas,sameScene:current.serialized===drawingBeforeLanguages.serialized,sameView:current.view===drawingBeforeLanguages.view});
      }
      await win.webContents.executeJavaScript('window.fixtureSetDrawingLanguage("en")');

      report.drawingSvgRoundTrip=await drawingFrame.executeJavaScript(
        '(async()=>{const codec=window.valleyExcalidrawIsland;const original=JSON.parse(document.getElementById("drawing-root").dataset.serialized);const shape=original.elements[0];const dataURL="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";const text="Blätter äöüß — 森林";const scene={...original,elements:[{...shape,link:"[[Habitat.md]]"},{...shape,id:"label",type:"text",y:160,width:260,height:25,text,originalText:text,fontSize:20,fontFamily:1,lineHeight:1.25,textAlign:"left",verticalAlign:"top",containerId:null,autoResize:true},{...shape,id:"image",type:"image",x:300,fileId:"pixel",status:"saved",scale:[1,1],crop:null}],files:{pixel:{id:"pixel",mimeType:"image/png",dataURL,created:1}}};const svg=await codec.encodeDrawingSvg(scene);const decoded=await codec.decodeDrawingSvg(svg);const edited={...decoded,elements:decoded.elements.map(element=>element.id===shape.id?{...element,width:240,version:element.version+1}:element)};const reopened=await codec.decodeDrawingSvg(await codec.encodeDrawingSvg(edited));const empty=await codec.decodeDrawingSvg(await codec.encodeDrawingSvg({...original,elements:[],files:{}}));let invalidRejected=false;try{await codec.decodeDrawingSvg("<svg xmlns=\\"http://www.w3.org/2000/svg\\"></svg>")}catch{invalidRejected=true}const xml=new DOMParser().parseFromString(svg,"image/svg+xml");const image=new Image();image.src=URL.createObjectURL(new Blob([svg],{type:"image/svg+xml"}));await image.decode();const result={text:reopened.elements.find(e=>e.id==="label").text,link:reopened.elements[0].link,width:reopened.elements[0].width,image:reopened.files.pixel.dataURL===dataURL,rendered:image.naturalWidth>0&&image.naturalHeight>0,embeddedFont:svg.includes("data:font/woff2;base64,"),paths:xml.querySelectorAll("path").length,empty:empty.elements.length,invalidRejected};URL.revokeObjectURL(image.src);return result})()'
      );

      await win.webContents.executeJavaScript('window.fixtureMountDrawingFence()');
      let fenceFrame;
      for(let i=0;i<200;i++){
        for(const frame of win.webContents.mainFrame.framesInSubtree.filter(f=>f.url.endsWith('/surface.html'))){if(await frame.executeJavaScript('!!document.querySelector(".excalidraw-fence-preview:not([hidden]) svg path")')){fenceFrame=frame;break}}
        if(fenceFrame)break;await wait(20)
      }
      if(!fenceFrame){const state=[];for(const frame of win.webContents.mainFrame.framesInSubtree)state.push(await frame.executeJavaScript('({url:location.href,body:document.body.innerHTML.slice(-6000)})'));throw Error('The registered Excalidraw fence must render its scene: '+JSON.stringify(state));}
      const fenceGeometry='(()=>{const root=document.querySelector(".excalidraw-fence"),svg=root?.querySelector("svg"),shape=svg?.querySelector("path");if(!shape)return null;return {root:root.getBoundingClientRect().toJSON(),svg:svg.getBoundingClientRect().toJSON(),shape:shape.getBoundingClientRect().toJSON(),filter:getComputedStyle(svg).filter,hint:!!root.querySelector(".excalidraw-fence-hint")}})()';
      report.drawingFenceDark=await fenceFrame.executeJavaScript(fenceGeometry);
      const sampleFence=async()=>{const bounds=await win.webContents.executeJavaScript('(()=>{const r=document.querySelector("#drawing-fence-host iframe").getBoundingClientRect();return {x:Math.round(r.x+4),y:Math.round(r.y+4),width:Math.round(r.width-8),height:Math.round(r.height-8)}})()');const image=await win.webContents.capturePage(bounds);const pixels=image.toBitmap();let bright=0,dark=0;for(let i=0;i<pixels.length;i+=4){const value=(pixels[i]+pixels[i+1]+pixels[i+2])/3;if(value>160)bright++;if(value<80)dark++}return{bright,dark}};
      await wait(100);report.drawingFenceDarkPaint=await sampleFence();
      await win.webContents.executeJavaScript('document.documentElement.setAttribute("data-theme","light");document.documentElement.style.colorScheme="light";undefined');
      for(let i=0;i<150;i++){report.drawingFenceLight=await fenceFrame.executeJavaScript(fenceGeometry);if(report.drawingFenceLight?.filter==='none')break;await wait(20)}
      await wait(100);report.drawingFenceLightPaint=await sampleFence();
      await win.webContents.executeJavaScript('document.documentElement.setAttribute("data-theme","dark");document.documentElement.style.colorScheme="dark";undefined');
      for(let i=0;i<150;i++){report.drawingFenceRestored=await fenceFrame.executeJavaScript(fenceGeometry);if(report.drawingFenceRestored&&report.drawingFenceRestored.filter!=='none')break;await wait(20)}
      await fenceFrame.executeJavaScript('document.querySelector(".excalidraw-fence-inner").click()');
      for(let i=0;i<50;i++){report.drawingFenceOpened=await win.webContents.executeJavaScript('window.fixtureOpenedDrawing');if(report.drawingFenceOpened)break;await wait(20)}

    `,
    verify(result) {
      assert.equal(result.drawingMounted, true)
      assert.equal(result.drawingRuntime, 'function')
      assert.equal(result.drawingChanged, true, 'Excalidraw must repaint after scene updates')
      assert.equal(result.drawingPreview, true, 'Excalidraw must export the embedded SVG')
      assert.deepEqual(result.drawingScene, [{ id: 'meadow', width: 180 }])
      assert.equal(result.drawingInitialLanguage, 'Rückgängig machen', 'The editor must initially use the plugin language')
      assert.deepEqual(result.drawingSvgRoundTrip, { text: 'Blätter äöüß — 森林', link: '[[Habitat.md]]', width: 240, image: true, rendered: true, embeddedFont: true, paths: result.drawingSvgRoundTrip.paths, empty: 0, invalidRejected: true })
      assert(result.drawingSvgRoundTrip.paths > 0, 'The SVG must retain visible drawing geometry')
      assert.deepEqual(result.drawingLanguages.map(({ language, label }) => ({ language, label })), [
        { language: 'en', label: 'Undo' }, { language: 'es', label: 'Deshacer' }, { language: 'fr', label: 'Annuler' },
        { language: 'zh-CN', label: '撤销' }, { language: 'de', label: 'Rückgängig machen' }, { language: 'unsupported', label: 'Undo' }
      ])
      assert(result.drawingLanguages.every(({ sameCanvas, sameScene, sameView }) => sameCanvas && sameScene && sameView), 'Language switching must preserve the mounted editor, edited scene, and view')

      for (const geometry of [result.drawingFenceDark, result.drawingFenceLight, result.drawingFenceRestored]) {
        assert.equal(geometry.hint, false, 'React must remove its loading hint without losing the SVG')
        assert(geometry.root.x >= 0 && geometry.root.y >= 0 && geometry.root.bottom <= 240, 'The fence must fit its declared surface height')
        assert(geometry.shape.width > 100 && geometry.shape.height > 50, 'The drawing must have visible geometry')
        assert(geometry.shape.left >= 0 && geometry.shape.right <= 600 && geometry.shape.top >= 0 && geometry.shape.bottom <= 240, 'The drawing must remain inside the surface')
      }
      assert.notEqual(result.drawingFenceDark.filter, 'none', 'Dark embeds must adapt the drawing colors')
      assert.equal(result.drawingFenceLight.filter, 'none')
      assert.notEqual(result.drawingFenceRestored.filter, 'none', 'An existing embed must follow theme switching')
      assert(result.drawingFenceDarkPaint.bright > 200, 'The dark embed must paint a clearly visible light outline')
      assert(result.drawingFenceLightPaint.dark > 200 && result.drawingFenceLightPaint.bright > 10000, 'The light embed must paint a dark outline on its light surface')
      assert.equal(result.drawingFenceOpened, 'Meadow.excalidraw')
    }
  }
}
