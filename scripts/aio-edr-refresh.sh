#!/bin/bash
# Оновлення локальної копії ЄДР з data.gov.ua (безкоштовно, офіційно).
set -e
DIR=/mnt/HC_Volume_106461592/aio/edr
mkdir -p "$DIR"
URL=$(curl -s -m 30 "https://data.gov.ua/api/3/action/package_search?q=%22%D0%B4%D0%B5%D1%80%D0%B6%D0%B0%D0%B2%D0%BD%D0%B8%D0%B9%20%D1%80%D0%B5%D1%94%D1%81%D1%82%D1%80%20%D1%8E%D1%80%D0%B8%D0%B4%D0%B8%D1%87%D0%BD%D0%B8%D1%85%22&rows=1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); r=[x for x in d['result']['results'][0]['resources'] if x.get('name','').lower().startswith('uo')][0]; print(r['url'])")
curl -sL -A "Mozilla/5.0" -o "$DIR/uo.zip" "$URL"
python3 "$DIR/import.py"
N=$(docker ps --format '{{.Names}}' | grep -i postgres | head -1)
docker exec -i "$N" psql -U aio -d aio -c "TRUNCATE edr_stage; CREATE TABLE IF NOT EXISTS edr_stage (LIKE edr_subjects);" >/dev/null
docker exec -i "$N" psql -U aio -d aio -c "\copy edr_stage (edrpou,name,short_name,opf,status,director,registered_at,terminated_info,bankruptcy) FROM STDIN WITH (FORMAT text)" < "$DIR/subjects.tsv" >/dev/null
docker exec -i "$N" psql -U aio -d aio -c "
TRUNCATE edr_subjects;
INSERT INTO edr_subjects SELECT DISTINCT ON (edrpou) edrpou,name,short_name,opf,status,
  regexp_replace(director,'<[^>]*>','','g'),registered_at,terminated_info,bankruptcy
FROM edr_stage ORDER BY edrpou,(status <> 'припинено') DESC,registered_at DESC;
ANALYZE edr_subjects;" >/dev/null
rm -f "$DIR/uo.zip" "$DIR/subjects.tsv"
echo "ЄДР оновлено $(date -I)"
