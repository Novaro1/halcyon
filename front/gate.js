// Halcyon front-link gate. Runs on a cross-origin front host: solves the backend
// proof-of-work, stores the session, points the wisp tunnel at the backend with
// ?t=<token>, THEN loads the app. Keeps the frontend anywhere while the tunnel
// phones home to the one backend origin. (On the backend's own origin the server
// gates server-side, so this only runs where window.HALCYON_BACKEND is set.)
(function () {
  var B = (window.HALCYON_BACKEND || "").replace(/\/+$/, "");
  var statusEl = document.getElementById("halcyon-gate-status");
  var gateEl = document.getElementById("halcyon-gate");
  function setStatus(m) { if (statusEl) statusEl.textContent = m; }
  function hideGate() { if (gateEl) gateEl.style.display = "none"; }
  function wsBase() { return B.replace(/^http/, "ws"); }
  function setWisp(token) {
    // Token as a path segment (not ?t=) so the wisp URL ends with "/", which the
    // libcurl transport requires; the backend reads it from /wisp/<token>/.
    try { localStorage.setItem("halcyon:wisp", wsBase() + "/wisp/" + token + "/"); } catch (e) {}
  }
  function storeSession(token) {
    try { localStorage.setItem("halcyon:session", JSON.stringify({ t: token, exp: Number(token.split(".")[0]) || 0 })); } catch (e) {}
  }
  function validStored() {
    try {
      var s = JSON.parse(localStorage.getItem("halcyon:session") || "null");
      if (s && s.t && s.exp > Date.now() + 120000) return s.t;
    } catch (e) {}
    return null;
  }
  function loadApp() {
    // Relative so they resolve under the origin root OR a sub-path (e.g. a GCS
    // bucket). proxy.js reads window.HALCYON_BASE for its absolute runtime/SW paths.
    var p = document.createElement("script");
    p.src = "./proxy.js";
    p.onload = function () {
      var a = document.createElement("script");
      a.src = "./app.js";
      a.onload = hideGate;
      document.body.appendChild(a);
    };
    document.body.appendChild(p);
  }
  function fail(m) { setStatus(m); }

  function sha256hex(a) {
    function R(n, x) { return (x >>> n) | (x << (32 - n)); }
    var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    var by=[],i; for(i=0;i<a.length;i++)by.push(a.charCodeAt(i)&0xff);
    var bl=by.length*8; by.push(0x80); while(by.length%64!==56)by.push(0);
    by.push(0,0,0,0,(bl>>>24)&0xff,(bl>>>16)&0xff,(bl>>>8)&0xff,bl&0xff);
    var w=new Array(64),j;
    for(j=0;j<by.length;j+=64){
      for(i=0;i<16;i++)w[i]=(by[j+i*4]<<24)|(by[j+i*4+1]<<16)|(by[j+i*4+2]<<8)|(by[j+i*4+3]);
      for(i=16;i<64;i++){var x1=w[i-15],x2=w[i-2];var s0=R(7,x1)^R(18,x1)^(x1>>>3);var s1=R(17,x2)^R(19,x2)^(x2>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)|0;}
      var A=h0,Bb=h1,C=h2,D=h3,E=h4,F=h5,G=h6,H=h7;
      for(i=0;i<64;i++){var S1=R(6,E)^R(11,E)^R(25,E);var ch=(E&F)^(~E&G);var t1=(H+S1+ch+K[i]+w[i])|0;var S0=R(2,A)^R(13,A)^R(22,A);var mj=(A&Bb)^(A&C)^(Bb&C);var t2=(S0+mj)|0;H=G;G=F;F=E;E=(D+t1)|0;D=C;C=Bb;Bb=A;A=(t1+t2)|0;}
      h0=(h0+A)|0;h1=(h1+Bb)|0;h2=(h2+C)|0;h3=(h3+D)|0;h4=(h4+E)|0;h5=(h5+F)|0;h6=(h6+G)|0;h7=(h7+H)|0;
    }
    function hx(x){return ((x>>>0).toString(16)).padStart(8,"0");}
    return hx(h0)+hx(h1)+hx(h2)+hx(h3)+hx(h4)+hx(h5)+hx(h6)+hx(h7);
  }

  if (!B) { return loadApp(); } // no backend configured — act same-origin
  var reuse = validStored();
  if (reuse) { setWisp(reuse); return loadApp(); }

  fetch(B + "/challenge", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (c) {
      var n = 0, CHUNK = 25000;
      function submit(num) {
        setStatus("Almost there…");
        fetch(B + "/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: c.token, number: num }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok && d.token) { storeSession(d.token); setWisp(d.token); loadApp(); }
            else fail("Could not verify — reload to retry.");
          })
          .catch(function () { fail("Network error — reload to retry."); });
      }
      function step() {
        var end = Math.min(n + CHUNK, c.max);
        for (; n < end; n++) { if (sha256hex(c.salt + n) === c.challenge) { return submit(n); } }
        if (n < c.max) { setTimeout(step, 0); } else { fail("Could not verify — reload to retry."); }
      }
      step();
    })
    .catch(function () { fail("Network error — reload to retry."); });
})();
