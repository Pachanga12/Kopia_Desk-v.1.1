import urllib.request, json, urllib.error

# get available drives from server
drives = json.loads(urllib.request.urlopen('http://127.0.0.1:4178/api/drives').read().decode('utf-8'))
if not drives:
	raise SystemExit('No drives available')
root = drives[0]['root']

payload = {'root': root, 'path': 'KopiaDesk/test_manifest.json', 'text': '{}'}
# write
req = urllib.request.Request('http://127.0.0.1:4178/api/write-text', data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
urllib.request.urlopen(req)
# read with meta
req2 = urllib.request.Request('http://127.0.0.1:4178/api/read-text', data=json.dumps({'root': root, 'path': 'KopiaDesk/test_manifest.json', 'meta': True}).encode('utf-8'), headers={'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req2)
print(resp.read().decode('utf-8'))
