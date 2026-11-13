import zipfile, re, html
SRC="/mnt/HC_Volume_106461592/aio/edr/fop.zip"; OUT="/mnt/HC_Volume_106461592/aio/edr/fop.csv"
import csv
def field(rec, tag):
    m=re.search(rf"<{tag}>(.*?)</{tag}>", rec, re.S)
    return re.sub(r"\s+"," ",html.unescape(m.group(1))).strip() if m else ""
n=0
with zipfile.ZipFile(SRC) as z, z.open("FOP.xml") as f, open(OUT,"w",encoding="utf-8",newline="") as out:
    w=csv.writer(out, quoting=csv.QUOTE_ALL); buf=""
    while True:
        chunk=f.read(4*1024*1024)
        if not chunk: break
        buf+=chunk.decode("cp1251","replace")
        parts=buf.split("</SUBJECT>"); buf=parts.pop()
        for rec in parts:
            i=rec.find("<SUBJECT>")
            if i<0: continue
            rec=rec[i:]
            name=field(rec,"NAME")
            if not name: continue
            reg=field(rec,"REGISTRATION"); reg_date=reg.split(";")[0].strip() if reg else ""
            w.writerow([field(rec,"RECORD"), name, field(rec,"STAN"), reg_date, field(rec,"TERMINATED_INFO")])
            n+=1
print("записів:", n)
