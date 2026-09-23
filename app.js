const $=s=>document.querySelector(s), codeEl=$("#code"), out=$("#output");
const run=$("#run"), stop=$("#stop"), stdin=$("#stdin"), dock=$("#inputDock");
let pyodide, worker, running=false, errorLine=null;

const cm=CodeMirror.fromTextArea(codeEl,{
  mode:"python",
  theme:"material-darker",
  lineNumbers:true,
  indentUnit:4,
  tabSize:4,
  indentWithTabs:false,
  autoCloseBrackets:true,
  matchBrackets:true,
  lineWrapping:false,
  gutters:["CodeMirror-linenumbers","errors"]
});

// Adapter keeps the proven V4 engine API unchanged.
const code={
  get value(){return cm.getValue()},
  set value(v){cm.setValue(v)},
  get selectionStart(){
    const p=cm.getCursor();
    return cm.indexFromPos(p);
  },
  focus(){cm.focus()}
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
variables:`name = "Alex"
age = 15

print("Name:", name)
print("Age:", age)`,
input:`name = input("What is your name? ")
age = int(input("How old are you? "))

print("Hello", name)
print("Next year you will be", age + 1)`,
selection:`age = int(input("How old are you? "))

if age >= 16:
    print("You are 16 or over")
else:
    print("You are under 16")`,
forloop:`for number in range(1, 6):
    print(number)`,
whileloop:`number = 1

while number <= 5:
    print(number)
    number = number + 1`,
lists:`colours = ["red", "blue", "green"]
colours.append("purple")

for colour in colours:
    print(colour)`,
functions:`def greet(name):
    print("Hello", name)

name = input("What is your name? ")
greet(name)`,
random:`import random

number = random.randint(1, 10)
print("Your random number is", number)`
};

function clearErrorHighlight(){
  if(errorLine!==null){
    cm.removeLineClass(errorLine,"background","error-line");
    cm.setGutterMarker(errorLine,"errors",null);
    errorLine=null;
  }
}
function saveLocal(){localStorage.setItem("laurel-v2",code.value);cursor();clearErrorHighlight()}
function cursor(){
  const p=cm.getCursor();
  $("#cursor").innerHTML=`Ln ${p.line+1} &nbsp; Col ${p.ch+1} &nbsp; Spaces: 4 &nbsp; Python`;
}
code.value=localStorage.getItem("laurel-v2")??starter;
cm.on("change",saveLocal);
cm.on("cursorActivity",cursor);
cm.addKeyMap({
  "Cmd-Enter":()=>startRun(),
  "Ctrl-Enter":()=>startRun(),
  Tab: editor=>editor.replaceSelection("    ","end")
});
cursor();

function append(t,c=""){let s=document.createElement("span");s.textContent=t;s.className=c;out.append(s);out.scrollTop=out.scrollHeight}
function resetOutput(){out.innerHTML=""}
$("#clearOut").onclick=resetOutput;
$("#clearCode").onclick=()=>{if(confirm("Clear the editor?")){code.value="";saveLocal()}};
$("#new").onclick=()=>{if(confirm("Start a new program?")){code.value="";saveLocal();resetOutput();code.focus()}};
$("#save").onclick=()=>{let b=new Blob([code.value],{type:"text/x-python"}),a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="main.py";a.click();URL.revokeObjectURL(a.href)};
$("#load").onchange=async e=>{let f=e.target.files[0];if(f){code.value=await f.text();saveLocal()}};
document.querySelectorAll("[data-example]").forEach(b=>b.onclick=()=>{code.value=examples[b.dataset.example];saveLocal();$("#exampleMenu").classList.remove("show");$("#advancedMenu").classList.remove("show")});


// V4 advanced menu
$("#advancedBtn").onclick=e=>{e.stopPropagation();$("#advancedMenu").classList.toggle("show");$("#exampleMenu").classList.remove("show")};
$("#examplesBtn").onclick=e=>{e.stopPropagation();$("#exampleMenu").classList.toggle("show")};
document.addEventListener("click",e=>{if(!e.target.closest(".advanced-wrap")){$("#advancedMenu").classList.remove("show");$("#exampleMenu").classList.remove("show")}});

// V4 light / dark control
function setTheme(light){
  document.body.classList.toggle("light",light);
  $("#lightBtn").classList.toggle("selected",light);
  $("#darkBtn").classList.toggle("selected",!light);
  cm.setOption("theme",light?"default":"material-darker");
  localStorage.setItem("laurel-theme",light?"light":"dark");
}
$("#lightBtn").onclick=()=>setTheme(true);
$("#darkBtn").onclick=()=>setTheme(false);
setTheme(localStorage.getItem("laurel-theme")==="light");

// Share links: encode starter code directly into URL, so GitHub Pages needs no database.
function encodeCode(text){
  const bytes=new TextEncoder().encode(text);
  let binary=""; bytes.forEach(b=>binary+=String.fromCharCode(b));
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function decodeCode(text){
  text=text.replace(/-/g,"+").replace(/_/g,"/");
  while(text.length%4)text+="=";
  const binary=atob(text),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
let sharedOriginal=null;
const params=new URLSearchParams(location.search);
if(params.has("code")){
  try{
    sharedOriginal=decodeCode(params.get("code"));
    code.value=sharedOriginal; saveLocal();
    $("#resetShared").classList.add("show");
    $("#hint").textContent="Starter code loaded from a shared link.";
  }catch(e){}
}
$("#share").onclick=async()=>{
  const url=new URL(location.href);
  url.search=""; url.searchParams.set("code",encodeCode(code.value));
  try{
    await navigator.clipboard.writeText(url.toString());
    $("#hint").innerHTML='<span class="share-note">Share link copied to clipboard ✓</span>';
  }catch(e){
    prompt("Copy this share link:",url.toString());
  }
  $("#advancedMenu").classList.remove("show");
};
$("#resetShared").onclick=()=>{
  if(sharedOriginal!==null && confirm("Reset the editor to the original shared starter code?")){
    code.value=sharedOriginal;saveLocal();resetOutput();
  }
};

async function boot(){
 try{
   pyodide=await loadPyodide();
   $("#ready").innerHTML='Ready <b class="lamp"></b>';
   $("#hint").textContent="Input will appear here when your program asks for it…";
   out.innerHTML='<span class="dim">Ready. Press Run to execute your program.</span>';
 }catch(e){out.innerHTML="";append("Python could not load. Check your internet connection and refresh.","err");$("#ready").textContent="Load failed"}
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
