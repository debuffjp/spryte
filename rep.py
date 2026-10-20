import sys
sys.stdout.reconfigure(encoding='utf8')
f=sys.argv[1]; s=open(f,encoding='utf8',newline='').read()
parts=sys.stdin.buffer.read().decode('utf8').replace('\r\n','\n').split('\n%%\n')
for p in parts:
    if not p.strip(): continue
    a,b=p.split('\n=>\n')
    a=a.strip('\n'); b=b.strip('\n')
    if s.count(a)!=1: print("NOMATCH",s.count(a),a[:50]); continue
    s=s.replace(a,b)
open(f,'w',encoding='utf8',newline='').write(s)
