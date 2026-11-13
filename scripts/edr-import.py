"""Стрімовий імпорт офіційного ЄДР (UO.xml, 3 ГБ) у TSV."""
import zipfile, re, sys, html

SRC = "/mnt/HC_Volume_106461592/aio/edr/uo.zip"
OUT = "/mnt/HC_Volume_106461592/aio/edr/subjects.tsv"

def field(rec, tag):
    m = re.search(rf"<{tag}>(.*?)</{tag}>", rec, re.S)
    if not m:
        return ""
    v = html.unescape(m.group(1))
    return re.sub(r"\s+", " ", v).strip()

def main():
    n = 0
    with zipfile.ZipFile(SRC) as z, z.open("UO.xml") as f, open(OUT, "w", encoding="utf-8") as out:
        buf = ""
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            buf += chunk.decode("cp1251", "replace")
            parts = buf.split("</SUBJECT>")
            buf = parts.pop()
            for rec in parts:
                i = rec.find("<SUBJECT>")
                if i < 0:
                    continue
                rec = rec[i:]
                edrpou = field(rec, "EDRPOU")
                if not edrpou:
                    continue
                reg = field(rec, "REGISTRATION")
                reg_date = reg.split(";")[0].strip() if reg else ""
                signers = field(rec, "SIGNERS")
                director = re.sub(r"\s*-\s*(керівник|підписант|.*)$", "", signers.split(";")[0]).strip() if signers else ""
                out.write("\t".join([
                    edrpou, field(rec, "NAME"), field(rec, "SHORT_NAME"), field(rec, "OPF"),
                    field(rec, "STAN"), director, reg_date,
                    field(rec, "TERMINATED_INFO"), field(rec, "BANKRUPTCY_READJUSTMENT_INFO"),
                ]).replace("\t\t", "\t \t") + "\n")
                n += 1
        if buf.strip():
            pass
    print("записів:", n)

main()
