"""Private hosted YouTube transcript collector. Public captions only; no audio downloads."""
import csv, io, json, os, re, secrets, threading, time, zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from flask import Flask, jsonify, make_response, redirect, request, send_file
from werkzeug.exceptions import Forbidden

app = Flask(__name__)
ACCESS_KEY = os.getenv("APP_ACCESS_TOKEN", secrets.token_urlsafe(32))
DEFAULT_CHANNEL = "https://www.youtube.com/@MadsDalProperty/videos"
state_lock = threading.Lock()
state = {"state": "idle", "stage": "", "done": 0, "total": 0, "title": "",
         "notice": "", "error": "", "channel": DEFAULT_CHANNEL, "result": None}
result_archive = None

# The first 18 Mads Dal videos manually verified on 18 Nov 2026. If cloud IP
# restrictions prevent enumerating the channel, only these are retried.
FALLBACK = [
    ("IYNkXrVxoWo", "We Haven't Seen A Property Opportunity Like This Since 2008"),
    ("aCpTDbbMjb4", "Never Buy ANY Land If You See These 10 Mistakes"),
    ("DM7zVz1A8TM", "How I Made £1,008,000 Tax-Free Flipping 3 Homes (full strategy)"),
    ("UE9DtG3fD4k", "How I Turned the Ugliest House in Belgravia Into £8M"),
    ("eRmqU0c2JcI", "How I Made £1.5M Profit From a Property Nobody Wanted"),
    ("09w0zd7Deo8", "a realistic day in the life of a £150,000,000 developer"),
    ("aw-lIngGhGM", "If I Had To Start From £0 in Property Developement, I'd Do This"),
    ("8_zecYtIeWA", "How I Bought This Building with No Money (Full Breakdown)"),
    ("ol3JnSQw598", "How I Made £250K Profit in 6 Months from a Simple Property Flip"),
    ("HhpDXCXFHws", "POV: You're building $30M in homes around the world | Episode I"),
    ("L-3k-Jl61Ts", "How I Closed a 3-Unit Property Deal Before the Bank Said Yes"),
    ("17hBZiysLt4", "How I Landed a £10M Portugese Mansion Redevelopment"),
    ("7BeYCjWFvhs", "I've built £150M of homes. Now I'm starting from £0, to prove anyone can"),
    ("OOne9Q5Tv2w", "Everything you need to find your first property development"),
    ("fwXiFuuTqfs", "The first 3 property development projects | 100 Unit Challenge EP01"),
    ("sPIZmZ-sL2g", "How 3 Property Deals Made Me a Millionaire..."),
    ("vWBgBYVVG4k", "I lost £500k trying to revolutionize the property sector..."),
    ("mirAf5v5fuM", "How I Built £150m Worth Of Property (My Story)")
]

def normalize(url):
    url = str(url).strip()
    if url.startswith("@"):
        url = "https://www.youtube.com/" + url
    if url.startswith("youtube.com/") or url.startswith("www.youtube.com/"):
        url = "https://" + url
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ("youtube.com", "www.youtube.com", "m.youtube.com"):
        raise ValueError("Enter a valid YouTube channel link.")
    parts = [x for x in parsed.path.split("/") if x]
    if not parts or not (parts[0].startswith("@") or (parts[0] in ("channel","user","c") and len(parts)>1)):
        raise ValueError("Please use a YouTube channel URL, not a video URL.")
    if parts[-1] in ("videos","shorts","streams","featured","live"):
        parts.pop()
    return "https://www.youtube.com/" + "/".join(parts)

def update(**data):
    with state_lock:
        state.update(data)

def list_videos(channel):
    from yt_dlp import YoutubeDL
    opts = dict(quiet=True, no_warnings=True, skip_download=True, extract_flat="in_playlist",
                ignoreerrors=True, socket_timeout=25, retries=1)
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(channel, download=False)
        entries = (info or {}).get("entries") or []
        rows, seen = [], set()
        for e in entries:
            if not isinstance(e, dict): continue
            raw = str(e.get("id") or e.get("url") or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{11}", raw):
                match = re.search(r"(?:v=|/shorts/|/watch/)([A-Za-z0-9_-]{11})", raw)
                raw = match.group(1) if match else ""
            if not raw or raw in seen: continue
            seen.add(raw)
            rows.append((raw, str(e.get("title") or raw)))
            if len(rows) >= 300: break
        if rows: return rows
        raise RuntimeError("Channel returned no videos")
    except Exception as exc:
        print("CHANNEL_ENUMERATION_FAILED", type(exc).__name__, str(exc)[:180], flush=True)
        if "@MadsDalProperty" in channel:
            update(notice="YouTube blocked full channel listing; trying 18 previously verified links instead. The export may be incomplete.")
            return FALLBACK
        raise

def captions(video_id):
    from youtube_transcript_api import YouTubeTranscriptApi
    from html import unescape
    tracks = list(YouTubeTranscriptApi().list(video_id))
    if not tracks: return None, "", "No captions offered"
    tracks.sort(key=lambda t: (not str(t.language_code).lower().startswith("en"), bool(t.is_generated)))
    track = tracks[0]
    data = track.fetch()
    segments = []
    for seg in data:
        t = unescape(str(seg.text or "")).strip()
        if t: segments.append((float(seg.start), t))
    if not segments: return None, "", "Empty caption track"
    return segments, str(track.language_code), ""

def hhmmss(sec):
    h, remainder = divmod(max(0,int(sec)), 3600)
    m,s = divmod(remainder,60)
    return "%02d:%02d:%02d" % (h,m,s)

def csv_bytes(rows,fields):
    out=io.StringIO(newline="")
    writer=csv.DictWriter(out,fieldnames=fields,extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return ("\ufeff"+out.getvalue()).encode("utf-8")

def run_collection(channel):
    global result_archive
    try:
        update(stage="listing",title="Finding public videos…")
        videos=list_videos(channel)
        update(total=len(videos),stage="fetching")
        combined=[]; rows=[]; issues=[]; individ=[]
        counts=Counter(); blocked_streak=0
        for i,(vid,title) in enumerate(videos,1):
            update(done=i-1,title=title)
            link="https://www.youtube.com/watch?v="+vid
            status,lang,transcript,error="no_transcript","","",""
            if blocked_streak>=3:
                status="not_attempted";error="Stopped after repeated request blocks"
            else:
                try:
                    segments,lang,error = captions(vid)
                    if segments:
                        status="ok"
                        transcript="\n".join(text for _,text in segments)
                        timed="\n".join("["+hhmmss(sec)+"] "+text for sec,text in segments)
                        heading=title+"\n"+link+"\nLanguage: "+lang+"\n\n"
                        combined.append(heading+timed)
                        safe=re.sub(r"[^A-Za-z0-9 _.-]"," ",title).strip()[:90]
                        individ.append(("videos/"+(safe or "Video")+"__"+vid+".txt",heading+timed))
                    blocked_streak=0
                except Exception as exc:
                    error=(type(exc).__name__+": "+str(exc))[:350]
                    key=error.lower()
                    status="blocked" if any(z in key for z in ("blocked","too many","429","403","ipblocked")) else "no_transcript" if any(z in key for z in ("disabled","notranscript","unavailable")) else "error"
                    blocked_streak=blocked_streak+1 if status=="blocked" else 0
            counts[status]+=1
            row=dict(video_id=vid,title=title,url=link,status=status,language=lang,transcript=transcript,error=error)
            rows.append(row)
            if status!="ok":issues.append(row)
            print("VIDEO",i,len(videos),status,vid,flush=True)
            update(done=i,title=title)
            if i < len(videos) and blocked_streak < 3: time.sleep(1.5)
        summary=dict(videos_listed=len(videos),transcripts_collected=counts["ok"],
                     not_available=counts["no_transcript"],errors=counts["error"],
                     blocked=counts["blocked"],not_attempted=counts["not_attempted"],
                     collected_at_utc=datetime.now(timezone.utc).isoformat())
        out=io.BytesIO()
        with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:
            z.writestr("all_transcripts.txt","\n\n"+"="*75+"\n\n".join(combined) if combined else "")
            z.writestr("all_videos.csv",csv_bytes(rows,["video_id","title","url","status","language","transcript","error"]))
            z.writestr("missing_or_failed.csv",csv_bytes(issues,["video_id","title","url","status","language","transcript","error"]))
            z.writestr("summary.json",json.dumps(summary,indent=2))
            for name,content in individ:z.writestr(name,content)
        result_archive=out.getvalue()
        update(state="done",stage="finished",result=summary,title="Export ready")
        print("FINISHED",json.dumps(summary),flush=True)
    except Exception as exc:
        update(state="error",error=str(exc)[:400],title="Collection failed")
        print("COLLECTION_ERROR",type(exc).__name__,str(exc)[:400],flush=True)

def start_job(url):
    global result_archive
    url=normalize(url)
    with state_lock:
        if state["state"]=="running":
            raise ValueError("A collection is already running.")
        state.update(state="running",stage="listing",done=0,total=0,title="Starting…",notice="",error="",channel=url,result=None)
    result_archive=None
    threading.Thread(target=run_collection,args=(url,),daemon=True).start()
    return dict(state)

@app.before_request
def auth():
    if request.path in ("/healthz","/robots.txt"): return
    query=request.args.get("key","")
    if request.path=="/" and secrets.compare_digest(query,ACCESS_KEY):
        resp=make_response(redirect("/"))
        resp.set_cookie("caption_access",ACCESS_KEY,secure=request.is_secure,httponly=True,samesite="Lax",max_age=2592000)
        return resp
    if not secrets.compare_digest(request.cookies.get("caption_access",""),ACCESS_KEY):
        raise Forbidden("Use your private app link.")

@app.after_request
def private_headers(resp):
    resp.headers["Cache-Control"]="no-store"
    resp.headers["X-Robots-Tag"]="noindex,nofollow,noarchive"
    resp.headers["X-Content-Type-Options"]="nosniff"
    return resp

@app.get("/healthz")
def health():
    return jsonify(ok=True)

@app.get("/robots.txt")
def robots():
    return "User-agent: *\nDisallow: /\n",200,{"Content-Type":"text/plain"}

@app.get("/")
def home():
    return Path(__file__).with_name("index.html").read_text(encoding="utf-8"),200,{"Content-Type":"text/html; charset=utf-8"}

@app.get("/api/status")
def status():
    with state_lock:return jsonify(dict(state))

@app.post("/api/start")
def start():
    try:
        data=request.get_json(silent=True) or {}
        return jsonify(start_job(data.get("url") or DEFAULT_CHANNEL))
    except ValueError as exc:
        return jsonify(error=str(exc)),409

@app.get("/download")
def download():
    if state["state"]!="done" or result_archive is None:
        return jsonify(error="No export is ready"),404
    return send_file(io.BytesIO(result_archive),mimetype="application/zip",as_attachment=True,download_name="youtube_transcripts_export.zip")

if os.environ.get("APP_AUTO_RUN","no").lower()=="yes":
    start_job(DEFAULT_CHANNEL)

if __name__=="__main__":
    from waitress import serve
    serve(app,host="0.0.0.0",port=int(os.getenv("PORT","10000")),threads=6)
