const $=s=>document.querySelector(s), codeEl=$("#code"), out=$("#output");
const run=$("#run"), stop=$("#stop"), stdin=$("#stdin"), dock=$("#inputDock");
let pyodide, worker, running=false, errorLine=null;

const cm=CodeMirror.fromTextArea(codeEl,{
  mode:"python", theme:"material-darker", lineNumbers:true, indentUnit:4, tabSize:4,
  indentWithTabs:false, autoCloseBrackets:true, matchBrackets:true, lineWrapping:false,
  gutters:["CodeMirror-linenumbers","errors"]
});
const code={
  get value(){return cm.getValue()}, set value(v){cm.setValue(v)},
  get selectionStart(){return cm.indexFromPos(cm.getCursor())}, focus(){cm.focus()}
};

const starter=`name = input("What is your name? ")
print("Hello", name)

age = int(input("How old are you? "))

if age >= 16:
    print("You're old enough!")
else:
    print("Not quite yet!")

colours = ["red", "blue", "green"]
colours.append("purple")

print("Your colours:")
for colour in colours:
    print("- " + colour)`;

const examples={
hello:`print("Hello, world!")`,
variables:`name = "Alex"\nage = 15\n\nprint("Name:", name)\nprint("Age:", age)`,
input:`name = input("What is your name? ")\nage = int(input("How old are you? "))\n\nprint("Hello", name)\nprint("Next year you will be", age + 1)`,
selection:`age = int(input("How old are you? "))\n\nif age >= 16:\n    print("You are 16 or over")\nelse:\n    print("You are under 16")`,
forloop:`for number in range(1, 6):\n    print(number)`,
whileloop:`number = 1\n\nwhile number <= 5:\n    print(number)\n    number = number + 1`,
lists:`colours = ["red", "blue", "green"]\ncolours.append("purple")\n\nfor colour in colours:\n    print(colour)`,
functions:`def greet(name):\n    print("Hello", name)\n\nname = input("What is your name? ")\ngreet(name)`,
random:`import random\n\nnumber = random.randint(1, 10)\nprint("Your random number is", number)`
};

// V6 workspace: up to six simple numbered programs. The tested V5.1 Python runtime below is unchanged.
const WORKSPACE_KEY="laurel-code-v6-workspace";
const MAX_TABS=6;
let workspace={programs:[],activeId:1};
let suppressSave=false, sharedOriginal=null;

function defaultWorkspace(){return {programs:[{id:1,code:starter}],activeId:1}}
function normaliseWorkspace(data){
  if(!data||!Array.isArray(data.programs)||!data.programs.length)return defaultWorkspace();
  const seen=new Set(), programs=[];
  for(const p of data.programs.slice(0,MAX_TABS)){
    let id=Number(p.id); if(!Number.isInteger(id)||id<1||id>MAX_TABS||seen.has(id))continue;
    seen.add(id); programs.push({id,code:String(p.code??"")});
  }
  if(!programs.length)return defaultWorkspace();
  programs.sort((a,b)=>a.id-b.id);
  const activeId=programs.some(p=>p.id===Number(data.activeId))?Number(data.activeId):programs[0].id;
  return {programs,activeId};
}
function activeProgram(){return workspace.programs.find(p=>p.id===workspace.activeId)}
function saveWorkspace(){localStorage.setItem(WORKSPACE_KEY,JSON.stringify(workspace))}
function nextFreeId(){for(let i=1;i<=MAX_TABS;i++)if(!workspace.programs.some(p=>p.id===i))return i;return null}
function setEditor(text){suppressSave=true;cm.setValue(text);suppressSave=false;clearErrorHighlight();cursor()}
function renderTabs(){
  const host=$("#programTabs"); host.innerHTML="";
  for(const p of [...workspace.programs].sort((a,b)=>a.id-b.id)){
    const tab=document.createElement("div"); tab.className="program-tab"+(p.id===workspace.activeId?" active":"");
    const label=document.createElement("button"); label.className="program-tab-label"; label.textContent=`Program ${p.id}`;
    label.onclick=()=>switchProgram(p.id); tab.appendChild(label);
    if(workspace.programs.length>1){
      const close=document.createElement("button"); close.className="program-tab-close"; close.textContent="×"; close.title=`Close Program ${p.id}`;
      close.onclick=e=>{e.stopPropagation();closeProgram(p.id)}; tab.appendChild(close);
    }
    host.appendChild(tab);
  }
  const full=workspace.programs.length>=MAX_TABS;
  $("#new").disabled=full; $("#tabPlus").disabled=full; $("#tabPlus").title=full?"Maximum of 6 programs":"New tab";
}
function switchProgram(id){
  if(id===workspace.activeId)return;
  const current=activeProgram(); if(current)current.code=code.value;
  workspace.activeId=id; setEditor(activeProgram().code); saveWorkspace(); renderTabs(); resetOutput(); code.focus();
}
function addProgram(initial=""){
  const id=nextFreeId(); if(id===null)return;
  const current=activeProgram(); if(current)current.code=code.value;
  workspace.programs.push({id,code:initial}); workspace.activeId=id; workspace.programs.sort((a,b)=>a.id-b.id);
  setEditor(initial);saveWorkspace();renderTabs();resetOutput();code.focus();
}
function closeProgram(id){
  const p=workspace.programs.find(x=>x.id===id); if(!p)return;
  if(p.code.trim()&&!confirm(`Close Program ${id}? Its code will be deleted.`))return;
  workspace.programs=workspace.programs.filter(x=>x.id!==id);
  if(!workspace.programs.length){workspace=defaultWorkspace()}
  else if(workspace.activeId===id)workspace.activeId=workspace.programs.sort((a,b)=>a.id-b.id)[0].id;
  setEditor(activeProgram().code);saveWorkspace();renderTabs();resetOutput();
}

function clearErrorHighlight(){
  if(errorLine!==null){cm.removeLineClass(errorLine,"background","error-line");cm.setGutterMarker(errorLine,"errors",null);errorLine=null}
}
function saveLocal(){
  if(suppressSave)return;
  const p=activeProgram(); if(p){p.code=code.value;saveWorkspace()}
  cursor();clearErrorHighlight();
}
function cursor(){const p=cm.getCursor();$("#cursor").innerHTML=`Ln ${p.line+1} &nbsp; Col ${p.ch+1} &nbsp; Spaces: 4 &nbsp; Python`}

function encodeText(text){
  const bytes=new TextEncoder().encode(text);let binary="";bytes.forEach(b=>binary+=String.fromCharCode(b));
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function decodeText(text){text=text.replace(/-/g,"+").replace(/_/g,"/");while(text.length%4)text+="=";const binary=atob(text),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));return new TextDecoder().decode(bytes)}
function encodeWorkspace(ws){return encodeText(JSON.stringify(ws))}
function decodeWorkspace(text){return normaliseWorkspace(JSON.parse(decodeText(text)))}

// Load shared workspace first, then old V5 single-code links, then local V6 workspace.
const params=new URLSearchParams(location.search);
if(params.has("ws")){
  try{workspace=decodeWorkspace(params.get("ws"));sharedOriginal=JSON.parse(JSON.stringify(workspace));$("#resetShared").classList.add("show");$("#hint").textContent="Starter programs loaded from a shared link."}catch(e){workspace=defaultWorkspace()}
}else if(params.has("code")){
  try{workspace={programs:[{id:1,code:decodeText(params.get("code"))}],activeId:1};sharedOriginal=JSON.parse(JSON.stringify(workspace));$("#resetShared").classList.add("show");$("#hint").textContent="Starter code loaded from a shared link."}catch(e){workspace=defaultWorkspace()}
}else{
  try{workspace=normaliseWorkspace(JSON.parse(localStorage.getItem(WORKSPACE_KEY)))}catch(e){workspace=defaultWorkspace()}
  // One-time carry-over of the pupil's V5.1 autosave into Program 1.
  if(!localStorage.getItem(WORKSPACE_KEY)&&localStorage.getItem("laurel-v2")!==null)workspace={programs:[{id:1,code:localStorage.getItem("laurel-v2")}],activeId:1};
}
setEditor(activeProgram().code);saveWorkspace();renderTabs();
cm.on("change",saveLocal);cm.on("cursorActivity",cursor);
cm.addKeyMap({"Cmd-Enter":()=>startRun(),"Ctrl-Enter":()=>startRun(),Tab:editor=>editor.replaceSelection("    ","end")});cursor();

function append(t,c=""){let s=document.createElement("span");s.textContent=t;s.className=c;out.append(s);out.scrollTop=out.scrollHeight}
function resetOutput(){out.innerHTML=""}
$("#clearOut").onclick=resetOutput;
$("#clearCode").onclick=()=>{if(confirm(`Clear Program ${workspace.activeId}?`)){code.value="";resetOutput();code.focus()}};
$("#new").onclick=()=>addProgram(); $("#tabPlus").onclick=()=>addProgram();
$("#save").onclick=()=>{let b=new Blob([code.value],{type:"text/x-python"}),a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`program-${workspace.activeId}.py`;a.click();URL.revokeObjectURL(a.href)};
$("#load").onchange=async e=>{let f=e.target.files[0];if(f){if(workspace.programs.length<MAX_TABS)addProgram(await f.text());else{code.value=await f.text()}e.target.value=""}};
document.querySelectorAll("[data-example]").forEach(b=>b.onclick=()=>{code.value=examples[b.dataset.example];$("#exampleMenu").classList.remove("show");$("#advancedMenu").classList.remove("show")});

$("#advancedBtn").onclick=e=>{e.stopPropagation();$("#advancedMenu").classList.toggle("show");$("#exampleMenu").classList.remove("show")};
$("#examplesBtn").onclick=e=>{e.stopPropagation();$("#exampleMenu").classList.toggle("show")};
document.addEventListener("click",e=>{if(!e.target.closest(".advanced-wrap")){$("#advancedMenu").classList.remove("show");$("#exampleMenu").classList.remove("show")}});
function setTheme(light){document.body.classList.toggle("light",light);$("#lightBtn").classList.toggle("selected",light);$("#darkBtn").classList.toggle("selected",!light);cm.setOption("theme",light?"default":"material-darker");localStorage.setItem("laurel-theme",light?"light":"dark")}
$("#lightBtn").onclick=()=>setTheme(true);$("#darkBtn").onclick=()=>setTheme(false);setTheme(localStorage.getItem("laurel-theme")==="light");

$("#share").onclick=async()=>{
  const current=activeProgram();if(current)current.code=code.value;saveWorkspace();
  const url=new URL(location.href);url.search="";url.searchParams.set("ws",encodeWorkspace(workspace));
  try{await navigator.clipboard.writeText(url.toString());$("#hint").innerHTML='<span class="share-note">Workspace share link copied ✓</span>'}catch(e){prompt("Copy this share link:",url.toString())}
  $("#advancedMenu").classList.remove("show");
};
$("#resetShared").onclick=()=>{
  if(sharedOriginal!==null&&confirm("Reset all programs to the original shared starter workspace?")){
    workspace=JSON.parse(JSON.stringify(sharedOriginal));setEditor(activeProgram().code);saveWorkspace();renderTabs();resetOutput();
  }
};

async function boot(){
 try{pyodide=await loadPyodide();$("#ready").innerHTML='Ready <b class="lamp"></b>';$("#hint").textContent="Input will appear here when your program asks for it…";out.innerHTML='<span class="dim">Ready. Press Run to execute your program.</span>'}
 catch(e){out.innerHTML="";append("Python could not load. Check your internet connection and refresh.","err");$("#ready").textContent="Load failed"}
}
boot();

/* V5.1 input engine
   Pyodide cannot use normal blocking input() in every browser, so Laurel pauses
   through a Promise. To keep pupil code completely ordinary, we quietly make
   pupil-defined functions async and await calls to them. This preserves source
   line numbers, so V5's error highlighting still points at the original line. */
function transformInputs(src){
  // Find ordinary pupil-defined function names. GCSE code overwhelmingly uses
  // standard `def name(...):` definitions; strings/comments are ignored below
  // when calls are rewritten.
  const functionNames=new Set();
  for(const line of src.split("\n")){
    const m=line.match(/^\s*def\s+([A-Za-z_]\w*)\s*\(/);
    if(m)functionNames.add(m[1]);
  }

  let r="",i=0,quote=null,triple=false,comment=false;
  let lastWord="", parenDepth=0;
  const awaitClosures=[];
  const isStart=c=>/[A-Za-z_]/.test(c||"");
  const isWord=c=>/[A-Za-z0-9_]/.test(c||"");

  while(i<src.length){
    const ch=src[i], next=src.slice(i,i+3);

    if(comment){
      r+=ch;
      if(ch==="\n"){comment=false;lastWord=""}
      i++;continue;
    }
    if(quote){
      if(triple && next===quote.repeat(3)){r+=next;i+=3;quote=null;triple=false;continue}
      if(!triple && ch===quote && src[i-1]!=="\\"){r+=ch;i++;quote=null;continue}
      r+=ch;i++;continue;
    }
    if(ch==="#"){comment=true;r+=ch;i++;continue}
    if(ch==="'"||ch==='"'){
      if(next===ch.repeat(3)){quote=ch;triple=true;r+=next;i+=3}else{quote=ch;r+=ch;i++}
      continue;
    }

    if(isStart(ch)){
      let j=i+1;
      while(j<src.length && isWord(src[j]))j++;
      const word=src.slice(i,j);
      let k=j;
      while(k<src.length && (src[k]===" "||src[k]==="\t"))k++;
      const isCall=src[k]==="(";

      if(word==="def"){
        // Every pupil function becomes async. This is intentionally invisible
        // to the pupil and lets input() work at any nesting depth.
        r+="async def";
        lastWord="def";
        i=j;continue;
      }

      if(word==="input" && isCall && lastWord!=="def"){
        // Parenthesise the awaited call so methods such as .strip() and .upper()
        // operate on the returned string, not on the coroutine itself.
        r+="(await __laurel_input";
        awaitClosures.push(parenDepth+1);
        lastWord=word;i=j;continue;
      }

      if(functionNames.has(word) && isCall && lastWord!=="def"){
        // Pupil functions are async internally. Parenthesising the awaited call
        // also keeps expressions such as get_name().strip() behaving normally.
        if(lastWord==="await"){
          r+=word;
        }else{
          r+="(await "+word;
          awaitClosures.push(parenDepth+1);
        }
        lastWord=word;i=j;continue;
      }

      r+=word;lastWord=word;i=j;continue;
    }

    if(ch==="("){
      parenDepth++;
      r+=ch;i++;continue;
    }
    if(ch===")"){
      r+=ch;
      if(awaitClosures.length && awaitClosures[awaitClosures.length-1]===parenDepth){
        r+=")";
        awaitClosures.pop();
      }
      parenDepth--;
      i++;continue;
    }
    if(!/\s/.test(ch) && ch!==".")lastWord="";
    if(ch==="\n")lastWord="";
    r+=ch;i++;
  }
  return r;
}
// Build a form dynamically around the dock so Enter submits reliably.
const form=document.createElement("form");dock.parentNode.insertBefore(form,dock);form.appendChild(dock);
let resolver=null;
form.onsubmit=e=>{e.preventDefault();if(resolver){let v=stdin.value;append(v+"\n","answer");dock.classList.add("hidden");let r=resolver;resolver=null;r(v)}};
function browserInput(prompt=""){append(String(prompt),"promptText");dock.classList.remove("hidden");stdin.value="";stdin.focus();return new Promise(r=>resolver=r)}

function markPythonError(err){
  clearErrorHighlight();
  const text=String(err);
  // Tracebacks can contain Pyodide internals. Prefer the final <exec> line number,
  // which corresponds to the pupil's transformed program in our runner.
  const matches=[...text.matchAll(/File "<exec>", line (\d+)/g)];
  if(!matches.length)return;
  const lineNumber=parseInt(matches[matches.length-1][1],10);
  if(!Number.isFinite(lineNumber)||lineNumber<1||lineNumber>cm.lineCount())return;
  errorLine=lineNumber-1;
  cm.addLineClass(errorLine,"background","error-line");
  const marker=document.createElement("div");
  marker.className="error-gutter-marker";
  marker.textContent="●";
  marker.title=`Error on line ${lineNumber}`;
  cm.setGutterMarker(errorLine,"errors",marker);
  cm.scrollIntoView({line:errorLine,ch:0},100);
  const summary=document.createElement("span");
  summary.className="error-summary";
  summary.textContent=`⚠ Error on line ${lineNumber}`;
  out.prepend(summary);
}
async function startRun(){
 if(!pyodide||running)return;
 running=true;run.disabled=true;stop.disabled=false;run.textContent="Running…";resetOutput();
 pyodide.setStdout({batched:s=>append(s+"\n")});pyodide.setStderr({batched:s=>append(s+"\n","err")});
 pyodide.globals.set("__laurel_input_js", browserInput);
 try{
   // __laurel_input_js is already a Python global proxy to our JS function.
   // Do not import it from `js`; that was the v0.2 bug.
   await pyodide.runPythonAsync(`async def __laurel_input(prompt=""):\n    return await __laurel_input_js(prompt)`);
   await pyodide.runPythonAsync(transformInputs(code.value));
 }catch(e){append(String(e)+"\n","err");markPythonError(e)}
 finally{running=false;run.disabled=false;stop.disabled=true;run.innerHTML='▶ &nbsp;Run <small>⌘ + Enter</small>';dock.classList.add("hidden");resolver=null}
}
run.onclick=startRun;
stop.onclick=()=>{append("\nProgram stopped by user.\n","err");location.reload()}; // reliable hard stop for runaway loops in this prototype
