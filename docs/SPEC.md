# Gate: Teknik Sözleşme (alt ajanlar bunun dışına çıkmaz)

Gate = sunucuda kullanıcı, klasör yetkisi, kopyalama kapısı, kural dosyası ve skill yönetim paneli.
Backend: Node 22 + TypeScript + Fastify (çalıştırma: `tsx`). Frontend: React + Vite + TypeScript. Veritabanı: `node:sqlite` (`DatabaseSync`).
Kurulu paketler (YENİ PAKET EKLENMEZ): backend → fastify, @fastify/cookie, @fastify/websocket, @fastify/static, typescript, tsx, @types/node, @types/ws. frontend → react, react-dom, @xterm/xterm, @xterm/addon-fit, vite, @vitejs/plugin-react, typescript, @types/react, @types/react-dom.
Alt ajanlar kod ÇALIŞTIRMAZ, test etmez, paket kurmaz. Doğrulamayı şef yapar.

## Ortam / yapılandırma (`core/config.ts`)
| Env | Varsayılan | Anlam |
|---|---|---|
| `GATE_HOST` | `127.0.0.1` | dinleme adresi (asla 0.0.0.0 varsayılan olmaz) |
| `GATE_PORT` | `4173` | port |
| `GATE_DRY_RUN` | `1` | `1`: sistem script'leri çalıştırılmaz, dosya yazımı sandbox'a gider |
| `GATE_DATA_DIR` | `/srv/gate/data` | sqlite + sandbox |
| `GATE_SCRIPTS_DIR` | dry: `/srv/gate/scripts`, gerçek: `/usr/local/lib/gate` (install.sh root sahipliğinde kopyalar) | root script'leri |
| `GATE_RULES_ROOT` | dry: `<DATA>/sandbox/claude-rules`, gerçek: `/opt/claude-rules` | kural kökü |
| `GATE_HOME_ROOT` | dry: `<DATA>/sandbox/home`, gerçek: `/home` | kullanıcı home kökü |
| `GATE_PROJECTS_ROOT` | dry: `<DATA>/sandbox/projects`, gerçek: `/srv/projects` | modül klasörleri |
| `GATE_CLAUDE_BIN` | `claude` | skill üretimi için |
| `GATE_MODULES` | (hepsi) | virgülle ayrılmış açık modül listesi |
| `GATE_FRONTEND_DIR` | `/srv/gate/frontend/dist` | statik arayüz |
Dry-run başlangıcında sandbox dizinleri otomatik oluşturulur: `<RULES_ROOT>/{global/rules,global/references,users/_template/rules,users/_template/references,scripts}`, `<HOME_ROOT>`, `<PROJECTS_ROOT>`.

## Çekirdek (`backend/src/core/`)
- `types.ts`: `Core` arayüzü = `{ db: DatabaseSync; cfg: Config; audit(actor,action,detail?): void; run(script: ScriptName, args: string[], stdin?: string): Promise<RunResult>; writeFile(absPath, content): Promise<void>; deleteFile(absPath): Promise<void>; requireAuth: preHandler }`. `RunResult = {ok:boolean; dryRun:boolean; code:number; stdout:string; stderr:string}`. `GateModule = { name: string; register(app: FastifyInstance, core: Core): void | Promise<void> }`.
- `config.ts`, `db.ts` (şema aşağıda, `CREATE TABLE IF NOT EXISTS`), `audit.ts`, `totp.ts` (RFC 6238, SHA1, 6 hane, 30 sn, ±1 pencere, kendi base32 kodu, `crypto` ile), `auth.ts`, `exec.ts`, `files.ts`, `modules.ts`.
- `modules.ts`: `backend/src/modules/<ad>/index.ts` dosyalarını dinamik `import()` ile yükler (`default` export = GateModule). Modüller birbirini import ETMEZ, yalnızca `core/types.ts`'i.
- `exec.ts`: SADECE `ScriptName` whitelist'indeki script'ler: `user-add user-del user-lock key-add key-del module-add module-del grant revoke egress-profile rules-init file-write file-delete`. Argümanlar `execFile` ile (shell YOK), `sudo -n -- <SCRIPTS_DIR>/<ad>.sh ...args`, 30 sn zaman aşımı, stdin desteği. Her script için argüman doğrulayıcı: kullanıcı adı `^[a-z][a-z0-9_-]{1,31}$`, modül adı `^[a-z][a-z0-9-]{1,31}$`, perm `r|rw`, dosya yolu yalnızca izinli köklerin altında ve `..` içermez. Doğrulama başarısızsa script çalıştırılmadan hata. `GATE_DRY_RUN=1` iken hiçbir şey çalıştırılmaz: `{ok:true,dryRun:true,code:0,stdout:'',stderr:''}` döner ve audit'e "DRY" notuyla yazılır.
- `files.ts`: `writeFile/deleteFile`. Dry-run: doğrudan sandbox'taki dosyaya yazar (yol yine kök altında olmak ZORUNDA). Gerçek mod: `file-write` / `file-delete` script'i (içerik stdin).
- `auth.ts`: parola `crypto.scrypt` (rastgele salt, `salt:hash` hex). Oturum: rastgele 32 bayt hex, çerez `gate_sid` (httpOnly, sameSite=strict, path=/), süre 12 saat, boşta 30 dk, `sessions` tablosunda. CSRF: GET dışındaki tüm `/api` isteklerinde `x-gate-csrf: 1` başlığı zorunlu, yoksa 403. Giriş hız sınırı: aynı (ip+kullanıcı) için 15 dk içinde 5 yanlıştan sonra 429 (bellekte). TOTP etkinse giriş `totp` ister; eksikse 401 `{error:"totp_required"}`. Güvenlik başlıkları: `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`.
- `server.ts`: Fastify, `@fastify/cookie`, `@fastify/websocket`, `@fastify/static` (SPA geri dönüş: bilinmeyen GET → `index.html`, `/api` hariç), modülleri yükler, `GATE_HOST:GATE_PORT` dinler. Tüm `/api/*` (auth durum/kurulum/giriş hariç) `requireAuth` ister; yoksa 401.

## Veritabanı şeması
```
admins(id INTEGER PK, username TEXT UNIQUE, pass_hash TEXT, totp_secret TEXT, totp_enabled INTEGER DEFAULT 0, created TEXT)
sessions(token TEXT PK, admin_id INTEGER, created INTEGER, last_seen INTEGER, expires INTEGER)
users(id INTEGER PK AUTOINCREMENT, username TEXT UNIQUE, display TEXT, locked INTEGER DEFAULT 0, created TEXT)
ssh_keys(id INTEGER PK, user_id INTEGER, key TEXT, comment TEXT, fingerprint TEXT, created TEXT, UNIQUE(user_id,key))
folders(id INTEGER PK, name TEXT UNIQUE, path TEXT, created TEXT)
grants(user_id INTEGER, folder_id INTEGER, perm TEXT CHECK(perm IN ('r','rw')), PRIMARY KEY(user_id,folder_id))
gates(user_id INTEGER PK, sftp INTEGER DEFAULT 0, forwarding INTEGER DEFAULT 0, egress TEXT DEFAULT 'none', egress_allow TEXT DEFAULT '')
skills(id INTEGER PK, name TEXT, target_kind TEXT, target_user TEXT, source TEXT, content TEXT, version INTEGER DEFAULT 1, created TEXT, updated TEXT, UNIQUE(name,target_kind,target_user))
skill_versions(id INTEGER PK, skill_id INTEGER, version INTEGER, content TEXT, source TEXT, created TEXT)
audit(id INTEGER PK, ts TEXT, actor TEXT, action TEXT, detail TEXT)
```
Kullanıcı/anahtar/klasör/yetki/kapı değişikliklerinde ÖNCE ilgili script çalıştırılır; başarılıysa veritabanı güncellenir; başarısızsa HTTP 500 `{error: stderr}` döner ve veritabanı değişmez. Her değişiklik `audit`'e yazılır (actor = admin kullanıcı adı).

## HTTP API (hepsi JSON, hata biçimi `{error:string}`)
**Auth**
- `GET /api/auth/status` → `{needsSetup, loggedIn, username?, totpEnabled?}` (kimlik gerekmez)
- `POST /api/auth/setup {username,password}`: yalnızca hiç admin yokken; parola ≥ 10 karakter; oturum açar → `{ok:true}`
- `POST /api/auth/login {username,password,totp?}` → `{ok:true}`
- `POST /api/auth/logout` → `{ok:true}`
- `POST /api/auth/totp/begin` → `{secret, otpauth}`; `POST /api/auth/totp/confirm {code}` → `{ok:true}` (etkinleştirir)
**Meta**: `GET /api/meta` → `{dryRun, rulesRoot, homeRoot, projectsRoot, modules:string[]}`
**Users** (modül `users`)
- `GET /api/users` → `[{id,username,display,locked:boolean,created,keyCount,grants:[{folderId,perm}]}]`
- `POST /api/users {username,display?}` → kullanıcı nesnesi; `user-add` + `rules-init`
- `POST /api/users/:id/lock {locked:boolean}` → `{ok:true}`; `user-lock`
- `DELETE /api/users/:id` → `{ok:true}`; `user-del`
**SSH anahtarları** (modül `sshkeys`)
- `GET /api/users/:id/keys` → `[{id,comment,fingerprint,key}]`
- `POST /api/users/:id/keys {key,comment?}`: `key` tek satır `ssh-ed25519|ssh-rsa|ecdsa-sha2-*` ile başlamalı; `key-add` (stdin)
- `DELETE /api/keys/:keyId`: `key-del` (stdin)
**Klasörler / yetkiler** (modül `folders`)
- `GET /api/folders` → `[{id,name,path}]`; `POST /api/folders {name}` (yol = `<PROJECTS_ROOT>/<name>`, `module-add`); `DELETE /api/folders/:id` (`module-del`, veriyi silmez)
- `GET /api/grants` → `[{userId,folderId,perm}]`
- `PUT /api/grants {userId,folderId,perm:'none'|'r'|'rw'}`: `grant`/`revoke` → `{ok:true}`
**Kapılar** (modül `gates`)
- `GET /api/gates` → `[{userId,username,sftp,forwarding,egress:'none'|'allowlist'|'open',egressAllow:string[]}]` (kullanıcısı olan herkes için; kayıt yoksa varsayılanlar: sftp=false, forwarding=false, egress='none')
- `PUT /api/gates/:userId {sftp,forwarding,egress,egressAllow}`: `egress-profile`; `egressAllow` yalnızca IPv4/IPv6/CIDR (isim yok)
**Kurallar** (modül `rules`)
- `GET /api/rules/tree` → `[{path,kind:'dir'|'file'}]` (kökten göreli, ör. `global/rules/a.md`)
- `GET /api/rules/file?path=` → `{path,content}`; `PUT /api/rules/file {path,content}`; `DELETE /api/rules/file?path=`
- Yol kök dışına çıkamaz; yalnızca `.md .sh .txt .json` uzantıları.
**Skills** (modül `skills`)
- `targetKind`: `home` → `<HOME_ROOT>/<user>/.claude/skills/<name>/SKILL.md`; `rules` → `<RULES_ROOT>/users/<user>/skills/<name>/SKILL.md`; `global` → `<RULES_ROOT>/global/skills/<name>/SKILL.md` (`global`'de user yok). `name` = `^[a-z][a-z0-9-]{1,63}$`.
- `GET /api/skills` → `[{id,name,targetKind,targetUser,version,updated}]`; `GET /api/skills/:id` → `+ {source,content,versions:[{version,created}]}`
- `POST /api/skills/generate {name,source}` → `{content,mode:'claude'|'template'}`. `claude` modu: `execFile(GATE_CLAUDE_BIN, ['-p', prompt, '--tools', ''])` (hiçbir araç açık değil), 120 sn zaman aşımı; hata/zaman aşımı olursa `template` modu: `source` metninden frontmatter (`name`, `description` = ilk cümle) + gövde üretir. Prompt: yalnızca geçerli bir SKILL.md çıktısı iste.
- `POST /api/skills/validate {name,content}` → `{ok,errors:string[]}`: frontmatter var; `name` klasör adıyla aynı; `description` boş değil, `TODO` değil, ≤1024 karakter; içerik ≤200 KB.
- `POST /api/skills {name,targetKind,targetUser?,source,content}`: doğrular, dosyayı yazar (`files.ts`), kaydeder, sürüm 1. `PUT /api/skills/:id {content,source?}`: sürüm +1, eskisi `skill_versions`'a. `DELETE /api/skills/:id`: dosyayı siler.
- `POST /api/skills/:id/copy {targetKind,targetUser?}`: başka hedefe kopya.
**Terminal** (modül `terminal`): `GET /api/terminal` WebSocket (oturum çerezi zorunlu, `Origin` başlığı host ile aynı olmalı). Oturum açılınca `python3 -c 'import pty;pty.spawn(["/bin/bash","-l"])'` child süreci (shell yok); istemci→sunucu: ham metin = stdin; sunucu→istemci: ham metin = stdout+stderr. Boşta 15 dk veya WS kapanınca süreç öldürülür (SIGKILL). Açılış/kapanış `audit`'e yazılır. Aynı anda en fazla 3 terminal.
**Audit** (modül `audit`): `GET /api/audit?limit=100&q=` → `[{id,ts,actor,action,detail}]` (yeniden eskiye, limit ≤ 500).

## Root script'leri (`/srv/gate/scripts/*.sh`)
Hepsi: `#!/usr/bin/env bash`, `set -euo pipefail`, `umask 077`, girdi doğrulama (regex yukarıdaki gibi), `PATH` sabit, tek satır JSON çıktı (`{"ok":true}` veya hata için stderr + çıkış kodu ≠ 0), `logger -t gate` ile kayıt. Kullanıcı girdisi asla `eval`/komut dizgisine eklenmez. Korunan hesaplar (`root`, uid < 1000 ve root sahipliğindeki `/etc/gate/protected-users` dosyası) üzerinde işlem reddedilir.
- `user-add.sh <user>`: `useradd -m -s /bin/bash`, `~/.ssh` (700) + `authorized_keys` (600), `~/.claude/skills` oluştur, sahipliği kullanıcıya ver.
- `user-del.sh <user>`: oturumları sonlandır, `userdel` (home silinmez, `/var/lib/gate/deleted/<user>-<zaman>` altına taşınır), `/etc/ssh/sshd_config.d/gate-<user>.conf` ve egress kuralını kaldır.
- `user-lock.sh <user> lock|unlock`: `usermod -L/-U`, `lock` iken `pkill -KILL -u`.
- `key-add.sh <user>` (stdin: anahtar satırı): `ssh-keygen -l -f` ile doğrula, yoksa ekle. `key-del.sh <user>` (stdin): tam eşleşen satırı kaldır.
- `module-add.sh <name>`: `<PROJECTS_ROOT>/<name>` oluştur, grup `mod-<name>`, `chgrp`, `chmod 2770`. `module-del.sh <name>`: yalnızca grubu sil (veri kalır).
- `grant.sh <user> <module> <r|rw>`: `rw` → `gpasswd -a` grup + önceki ACL'yi kaldır; `r` → gruptan çıkar + `setfacl -R -m u:<user>:rX` ve `-d -m u:<user>:rX`. `revoke.sh <user> <module>`: gruptan çıkar + `setfacl -R -x u:<user>` (varsayılan ACL dahil).
- `egress-profile.sh <user> <sftp 0|1> <forwarding 0|1> <egress none|allowlist|open> [csv-ip]`: (a) `/etc/ssh/sshd_config.d/gate-<user>.conf`: `Match User <user>` + `AllowTcpForwarding no|yes`, `AllowAgentForwarding no`, `X11Forwarding no`, `PermitTunnel no`, sftp=0 ise `ForceCommand /usr/local/sbin/gate-shell`; `sshd -t` başarısızsa dosyayı geri al, `systemctl reload ssh`. (b) `/etc/gate/egress/<user>.nft` + toplu `/etc/gate/egress.nft` (nft tablo `inet gate`, `output` zinciri, `meta skuid <uid>`: loopback ve `ct state established,related` kabul; `none` → diğer her şey drop; `allowlist` → csv IP/CIDR kabul, kalan drop; `open` → kural yok); `nft -c -f` doğrula, sonra yükle.
- `gate-shell.sh` (kurulum: `/usr/local/sbin/gate-shell`): `SSH_ORIGINAL_COMMAND` boşsa kullanıcının shell'ini `exec -l`; `scp|sftp-server|internal-sftp|rsync` ile başlıyorsa reddet.
- `rules-init.sh <user>`: `<RULES_ROOT>/users/_template` → `users/<user>`; root:root, 755 (varsa dokunma).
- `file-write.sh <abs-path>` (stdin içerik): yol yalnızca `/opt/claude-rules/` veya `/home/<kullanıcı>/.claude/skills/` altında, `..` ve symlink yok; dizinleri oluştur; `/home` altındakilerde sahipliği o kullanıcıya ver. `file-delete.sh <abs-path>`: aynı kök kontrolü, dosyayı (ve boşsa üst skill klasörünü) sil.
- `install.sh`: `gate-shell`'i kurar, `/etc/sudoers.d/gate` içine yalnızca yukarıdaki script'leri (tam yol, `NOPASSWD`) yazar ve `visudo -c` ile doğrular. `docs/sudoers.d-gate.example` örnek dosyası da yazılır. Çalıştırılacak kullanıcı `GATE_SERVICE_USER` (zorunlu, kurulumda verilir).

## Frontend (`frontend/src/`)
Vite + React + TS, tek sayfa uygulama, `vite.config.ts`: `build.outDir=dist`, geliştirmede `/api` → `http://127.0.0.1:4173` proxy (WebSocket dahil). Çıktı Türkçe arayüz.
- `core/`: `api.ts` (fetch sarmalayıcı: `credentials:'same-origin'`, GET dışında `x-gate-csrf: 1`, hata `{error}` → `throw`), `session.tsx` (durum + giriş), `Layout.tsx` (kenar çubuğu + üst şerit + Dry-run uyarı bandı), `ui.tsx` (Button, Card, Table, Modal, Badge, Toast, ConfirmDialog), `styles.css` (koyu/açık tema, `prefers-color-scheme`, 16px yan boşluk, mobilde de kullanılabilir), `App.tsx` (hash tabanlı yönlendirme; ek paket yok).
- `features/<ad>/` her biri `index.tsx` dışa açar `{ id, title, icon, Page }` ve **yalnızca** `core/`'u import eder: `users` (liste, oluştur, kilitle, sil, anahtar ekle/kaldır modalı), `folders` (klasör listesi/oluştur/sil + kullanıcı × klasör matrisi: Yok/Oku/Oku+Yaz seçici), `gates` (kullanıcı başına sftp/forwarding anahtarları, egress seçimi, IP listesi), `rules` (ağaç + metin editörü + kaydet/sil + "kullanıcı için şablondan aç"), `skills` ("Skill Stüdyosu": hedef seç (tür + kullanıcı), ad, düz metin kutusu, "Skill'e çevir" → taslak editörü → "Doğrula" → "Kaydet"; listede filtre, düzenle, sürümler, kopyala, sil), `terminal` (xterm.js + fit, WebSocket, bağlantı durumu, Ayır/Yeniden bağlan), `audit` (tablo, arama kutusu, yenile), `settings` (TOTP kurulumu: gizli anahtar + otpauth + kod doğrulama).
- `core/registry.ts`: özellikleri toplar; `GET /api/meta.modules` içinde olmayanları menüden çıkarır.
- İlk açılış: `needsSetup` ise yönetici oluşturma ekranı; değilse giriş ekranı (TOTP alanı `totp_required` gelince görünür).
- Erişilebilirlik: etiketli form alanları, odak halkası, `aria-live` toast, klavye ile kullanılabilir modal, renk tek başına anlam taşımaz.

## EK: Anahtar Üret ve Bağlantı Dosyası (modül `sshkeys`)
Amaç: kullanıcı hiçbir şey üretmez; yönetici butona basar, kullanıcıya tek dosya verir, kullanıcı çift tıklayıp bağlanır.

**Uçlar**
- `POST /api/users/:id/keys/generate {host, port?, comment?}` → `{keyId, fingerprint, expiresIn: 600, downloads: {windows: string, unix: string}}`. `host`: DNS adı, IPv4 veya IPv6 (≤253 karakter, yalnızca `[A-Za-z0-9.:-]`, baş/son nokta yok); `port`: 1-65535, varsayılan 22; `comment` varsayılan `gate-<kullanıcı>`. Doğrulama hatası 400.
- `GET /api/keys/download/:token?os=windows|unix` → özel anahtarı gömülü bağlantı betiği. Başlıklar: `Content-Disposition: attachment; filename="baglan-<kullanıcı>.cmd|.sh"`, `Cache-Control: no-store`, `Content-Type: application/octet-stream`. Oturum zorunlu. Her `os` için **tek kez** indirilir (ikinci istek 410); token 10 dakika sonra veya iki dosya da indirildiğinde silinir; geçersiz/süresi dolmuş token 404.

**Üretim (backend)**
- `ssh-keygen -t ed25519 -N "" -C <comment> -f <tmp>` (`execFile`, shell yok). `tmp` = `<DATA_DIR>/tmp/<rastgele>/` (0700). Dosyalar okunduktan hemen sonra, hata olsa bile (`finally`) silinir; dizin de silinir.
- Genel anahtar mevcut anahtar ekleme akışıyla (`key-add`, `ssh_keys` tablosu) kaydedilir; **özel anahtar diske veya veritabanına YAZILMAZ**, yalnızca bellekteki `Map<token,{userId,username,privateKey,host,port,expires,used:{windows,unix}}>` içinde tutulur; süre dolunca/iki indirmeden sonra `Map`'ten silinir.
- Token: 32 bayt rastgele hex. `audit`: `keys.generate` (anahtar içeriği YAZILMAZ), `keys.download`.
- Aynı kullanıcı için en fazla 3 bekleyen token.

**Betik şablonları** (yalnızca doğrulanmış `host`/`port`/kullanıcı adı gömülür; özel anahtar OpenSSH biçimidir, satır satır yazılır):
- Windows `.cmd`: `@echo off`; `%USERPROFILE%\.ssh` yoksa oluştur; anahtar dosyası zaten varsa önce `icacls "<dosya>" /grant:r "%USERNAME%:F" >nul`, ardından `del /f /q "<dosya>" >nul` ile sil; anahtarı satır satır `echo` ile `%USERPROFILE%\.ssh\gate-<kullanıcı>` dosyasına yaz; `icacls "<dosya>" /inheritance:r /grant:r "%USERNAME%:R"`; `ssh -i "<dosya>" -o StrictHostKeyChecking=accept-new -p <port> <kullanıcı>@<host>`; sonunda `pause`. CRLF satır sonları.
- Unix `.sh`: `#!/usr/bin/env bash`; `set -eu`; `~/.ssh` (700); anahtarı `cat > ~/.ssh/gate-<kullanıcı> <<'GATE_KEY'` ile yaz, `chmod 600`; `exec ssh -i ... -o StrictHostKeyChecking=accept-new -p <port> <kullanıcı>@<host>`. LF.

**Arayüz (kullanıcılar sayfası, anahtar penceresi)**
- Pencerenin başında büyük **"Anahtar üret"** düğmesi; altında "Sunucu adresi" alanı (tarayıcıda `localStorage` ile hatırlanır) ve isteğe bağlı "Port" alanı.
- Üretimden sonra: iki indirme düğmesi ("Windows için indir", "Mac / Linux için indir"), geri sayım (10 dk), her düğme indirildikten sonra "indirildi" olur ve pasifleşir. Altında kullanıcıya iletilecek 3 maddelik düz Türkçe talimat kutusu ("1. Dosyayı indirin. 2. Çift tıklayın (Mac/Linux'ta terminalde `bash baglan-<ad>.sh`). 3. İlk bağlanışta 'yes' ya da Enter.") ve "Talimatı kopyala" düğmesi.
- Uyarı bandı: "Bu dosya bir şifre gibidir. Yalnızca kullanıcının kendisine güvenli kanaldan verin; paylaşılan bir sohbete atmayın."
- Eski elle yapıştırma formu "Gelişmiş: kendi anahtarını ekle" başlığı altında açılır/kapanır bölüme taşınır; işlevi aynı kalır.

## EK-2: Portal (kullanıcı paneli, sandbox'lı terminal, kayıt ve izleme)
Amaç: takım arkadaşı SSH KULLANMAZ. Portal'a (ayrı web sunucusu) parola + zorunlu TOTP ile girer, tarayıcı terminalinden ajan (`claude`) açar. Terminal, kullanıcının Linux hesabıyla ve systemd sandbox'ı içinde çalışır; yalnızca yetki verilen proje klasörlerini görür. Dosya indirme yolu YOKTUR. Her oturum kaydedilir; admin canlı izler, geriye dönük oynatır, sonlandırır.

### Süreçler ve yapılandırma
- Admin paneli değişmeden kalır (`src/server.ts`, `127.0.0.1:4173`).
- Portal ayrı giriş noktası: `backend/src/portal.ts`. Aynı veritabanını (`<DATA_DIR>/gate.db`) ve `core/`'u kullanır; admin uçlarını YÜKLEMEZ.
- Env: `GATE_PORTAL_HOST` (varsayılan `0.0.0.0`), `GATE_PORTAL_PORT` (varsayılan `4180`), `GATE_SESSIONS_DIR` (varsayılan `<DATA_DIR>/sessions`, 0700). Portal portu SSH ile aynı güvenlik duvarı kuralına tabidir (yalnızca Tailscale + yerel ağ).
- Portal güvenlik başlıkları: admin ile aynı + `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`. Statik dosya: yalnızca `frontend/dist/portal.html` ve `frontend/dist/assets/*`; bilinmeyen GET → `portal.html` (`/papi` hariç). Portal'da indirme, dosya okuma veya `Content-Disposition` dönen HİÇBİR uç yoktur.

### Veritabanı (yeni tablolar, `CREATE TABLE IF NOT EXISTS`)
```
portal_accounts(user_id INTEGER PK, pass_hash TEXT, must_change INTEGER DEFAULT 1, totp_secret TEXT, totp_enabled INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, created TEXT, last_login TEXT)
portal_sessions(token TEXT PK, user_id INTEGER, created INTEGER, last_seen INTEGER, expires INTEGER)
term_sessions(id TEXT PK, user_id INTEGER, unit TEXT, started TEXT, ended TEXT, end_reason TEXT, bytes_out INTEGER DEFAULT 0, bytes_in INTEGER DEFAULT 0)
settings(key TEXT PK, value TEXT)
```
`settings` varsayılanları: `portal.idle_minutes=15`, `portal.max_minutes=240`, `portal.max_concurrent=1` (kullanıcı başına).

### Portal kimlik doğrulama (`/papi`, CSRF başlığı `x-gate-csrf: 1`, çerez `gate_psid`; admin çerezi `gate_sid` ile karışmaz)
- `GET /papi/status` → `{loggedIn, username?, stage?: 'change_password'|'setup_totp'|'ready'}`
- `POST /papi/login {username,password,totp?}` → `{ok, stage}`. Hesap yok/`enabled=0`/kullanıcı `locked=1` → 401 (aynı hata metni). Hız sınırı admin ile aynı. `totp_enabled=1` ise `totp` zorunlu (`totp_required`).
- `POST /papi/password {current,new}` (≥12 karakter, kullanıcı adını içeremez) → `must_change=0`.
- `POST /papi/totp/begin` → `{secret, otpauth}`; `POST /papi/totp/confirm {code}`. `stage` `ready` olmadan terminal açılamaz (403 `{error:'setup_incomplete'}`).
- `POST /papi/logout`. Oturum: 8 saat, boşta 30 dk.

### Portal terminali
- `GET /papi/terminal` WebSocket (çerez + `Origin` eşleşmesi + `stage=ready`). Kullanıcının açık terminal sayısı `max_concurrent`'ı aşıyorsa 1008 ile kapatılır.
- Başlatma: `id = randomBytes(12).hex`; `unit = gate-portal-<username>-<id>`; süreç: `python3 -c 'import pty,sys;pty.spawn(sys.argv[1:])' sudo -n -- <SCRIPTS_DIR>/portal-shell.sh <username> <id>` (`execFile`/`spawn`, shell yok). Dry-run'da sudo yerine `/bin/bash --norc -i` başlatılır (yalnızca geliştirme için) ve meta'da `dryRun:true` görünür.
- Protokol: istemci→sunucu metin = stdin; istemci JSON `{"t":"resize","cols":N,"rows":N}` (1≤N≤500) → pty boyutu `stty` ile değil, python sarmalayıcıya `SIGWINCH` + `TIOCSWINSZ` ile iletilir: sarmalayıcı, `fcntl.ioctl` kullanan kısa python koduyla yazılır (ek dosya: `backend/src/core/ptyhost.py`, stdin'den gelen `\x00RESIZE <cols> <rows>\n` kontrol satırını yakalar, geri kalanını pty'ye yazar). Sunucu→istemci: ham çıktı.
- Sınırlar: boşta `idle_minutes` → sonlandır (`end_reason='idle'`); toplam `max_minutes` → sonlandır (`'max'`); WS kapanınca → sonlandır (`'closed'`); admin → `'admin'`. Sonlandırma: önce `sudo -n <SCRIPTS_DIR>/session-kill.sh <unit>`, ardından yerel süreç SIGKILL.
- Kayıt: `<SESSIONS_DIR>/<id>.cast` (asciicast v2, 0600): başlık `{"version":2,"width":..,"height":..,"timestamp":..,"env":{"TERM":"xterm-256color"},"title":"<username>"}`; her olay `[saniye, "o"|"i", "veri"]` satırı. `"i"` olayları da yazılır (kullanıcının yazdıkları). `term_sessions` satırı başlangıçta oluşturulur, bitişte güncellenir. Audit: `portal.login`, `portal.terminal.open`, `portal.terminal.close` (detay: id, neden, bayt).
- Canlı izleme yayını: bellekte `Map<id, Set<listener>>`; çıktı her parçada dinleyicilere iletilir.

### Admin uçları (admin sunucusunda, `requireAuth`; yeni modül `portal`)
- `GET /api/portal/accounts` → `[{userId,username,enabled,mustChange,totpEnabled,lastLogin,portalMode}]` (`portalMode` = kullanıcı `gate-portal` grubunda mı; `portal-mode.sh status` ile değil, DB alanı `users.portal_mode` ile; şema göçü: `ALTER TABLE users ADD COLUMN portal_mode INTEGER DEFAULT 0` yoksa ekle).
- `POST /api/portal/accounts/:userId` → hesap oluşturur/sıfırlar; 16 karakterlik rastgele geçici parola üretir (yalnızca bu yanıtta döner), `must_change=1`, `totp_enabled=0`, `totp_secret=NULL` → `{tempPassword}`. Aynı anda `portal-mode.sh <user> on` çalıştırır (SSH kapanır), `users.portal_mode=1`.
- `POST /api/portal/accounts/:userId/enabled {enabled}`; `DELETE /api/portal/accounts/:userId` → hesabı siler, `portal-mode.sh <user> off`, `portal_mode=0`.
- `PUT /api/portal/apikey/:userId {key}` → `apikey-set.sh <user>` (stdin: anahtar; `^sk-ant-[A-Za-z0-9_-]{20,200}$`), anahtar DB'ye/audit'e YAZILMAZ; `DELETE` → `apikey-set.sh <user> --delete`. `GET /api/portal/accounts` içinde yalnızca `hasApiKey:boolean` (DB alanı `users.has_api_key`, göçle eklenir).
- `GET/PUT /api/portal/settings` → `{idleMinutes(1-240), maxMinutes(5-1440), maxConcurrent(1-5)}`.
- `GET /api/sessions?active=0|1&user=` → `[{id,userId,username,unit,started,ended,endReason,bytesOut,bytesIn,live:boolean}]` (yeniden eskiye, ≤500).
- `GET /api/sessions/:id/cast` → asciicast metni (`text/plain`, `no-store`); yalnızca admin.
- `GET /api/sessions/:id/watch` WebSocket (admin çerezi + Origin): önce kayıttaki çıktıyı (yalnızca `"o"`) gönderir, sonra canlı çıktıyı; istemciden gelen her mesaj YOK SAYILIR (salt okunur).
- `POST /api/sessions/:id/kill` → sonlandır (`'admin'`).
- `GET /api/agentlogs/:userId` → `agent-logs.sh <user> list` çıktısı `[{file,size,mtime}]`; `GET /api/agentlogs/:userId/file?name=` → `agent-logs.sh <user> read <name>` (≤5 MB, JSONL metni). `name` = `^[A-Za-z0-9._-]{1,200}\.jsonl$`, alt dizin adı dahil `^[A-Za-z0-9._-]{1,200}/[A-Za-z0-9._-]{1,200}\.jsonl$`.
- Admin portal oturumları ile portal sunucusu arasındaki canlı izleme/sonlandırma: iki süreç ayrı olduğu için portal sunucusu yalnızca `127.0.0.1:<GATE_PORTAL_PORT+1>` (varsayılan 4181) üzerinde dahili bir kontrol ucu açar: `GET /internal/live` (JSON: aktif id listesi), `WS /internal/watch/:id`, `POST /internal/kill/:id`. Her istek `x-gate-internal: <token>` başlığı ister; token `<DATA_DIR>/internal.token` (0600, ilk açılışta 32 bayt hex üretilir). Admin sunucusu canlı izleme/kill/live için bu uca vekillik eder.

### Root script'leri (ek; `ScriptName` whitelist'ine ve install.sh/sudoers listesine eklenir, aynı üslup ve korunan-kullanıcı kontrolü)
- `portal-shell.sh <user> <id>`: `id` = `^[a-f0-9]{24}$`. Kullanıcının `gate-portal` grubunda olması ZORUNLU, yoksa ret. Proje erişimleri sistemden okunur: `/srv/projects/*` her dizin için kullanıcı `mod-<ad>` grubundaysa → rw; `getfacl` ile `user:<user>:r-x` varsa → r. `exec systemd-run --quiet --pty --wait --collect --unit=gate-portal-<user>-<id> --uid=<user> --gid=<user's primary gid> -p WorkingDirectory=/home/<user> -p ProtectSystem=strict -p ProtectHome=tmpfs -p BindPaths=/home/<user> -p TemporaryFileSystem=/srv:ro -p BindPaths=/srv/projects/<rw>... -p BindReadOnlyPaths=/srv/projects/<r>... -p TemporaryFileSystem=/opt/claude-rules/users:ro -p BindReadOnlyPaths=/opt/claude-rules/users/<user> -p InaccessiblePaths=/etc/gate -p InaccessiblePaths=/etc/sudoers.d -p PrivateTmp=yes -p PrivateDevices=yes -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes -p IPAddressDeny=any -p IPAddressAllow=localhost -p IPAddressAllow=160.79.104.0/23 -p IPAddressAllow=2607:6bc0::/48 -p LoadCredential=anthropic:/etc/gate/keys/<user>.key (yalnızca dosya varsa) -p Environment=TERM=xterm-256color -p Environment=HOME=/home/<user> -p Environment=USER=<user> -p Environment=CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -p UMask=0027 -p RuntimeMaxSec=<yok; süreyi backend yönetir> -- /bin/bash -l`. Bind edilecek proje listesi boşsa `/srv` boş tmpfs kalır. Tüm yol adları regex ile doğrulanır.
- `session-kill.sh <unit>`: `unit` = `^gate-portal-[a-z][a-z0-9_-]{1,31}-[a-f0-9]{24}$`; `systemctl kill --signal=SIGKILL <unit>.service` ve `systemctl stop <unit>.service` (hata yok sayılır).
- `portal-mode.sh <user> on|off|status`: `gate-portal` grubu yoksa oluştur; on → gruba ekle + `pkill -KILL -u <user> sshd` (mevcut SSH oturumlarını kapat); off → gruptan çıkar.
- `apikey-set.sh <user> [--delete]`: stdin'den tek satır anahtar okur, regex doğrular, `/etc/gate/keys/<user>.key` (dizin root:root 0700, dosya root:root 0600) olarak atomik yazar; `--delete` siler.
- `agent-logs.sh <user> list|read <name>`: kök `/home/<user>/.claude/projects`; `list` → tek satır JSON dizi (en yeni 200 dosya, `find -maxdepth 2 -name '*.jsonl' -type f`, symlink izlemez); `read` → kök altında, symlink değil, ≤5 MB dosyayı stdout'a basar.
- `install.sh` ekleri: (1) `gate-portal` grubu; (2) `/etc/ssh/sshd_config.d/gate-00-portal.conf` içeriği `DenyGroups gate-portal`, `sshd -t` başarısızsa geri al, `systemctl reload ssh`; (3) `/etc/gate/keys` (root 0700); (4) `claude` ikili dosyasını `GATE_CLAUDE_SRC` (varsayılan: `readlink -f /home/<GATE_SERVICE_USER>/.local/bin/claude`) kaynağından `/usr/local/bin/claude` olarak root:root 0755 kopyala; (5) `/etc/claude-code/CLAUDE.md` (root 0644; yoksa yaz, varsa dokunma) içeriği: "Bu sunucuda her oturumun başında önce `/opt/claude-rules/global/` altındaki kuralları, sonra `/opt/claude-rules/users/$USER/` altındaki kuralları oku ve uy. Yalnızca `/srv/projects/` altında sana açılmış klasörlerde çalış. Dosya içeriklerini sunucu dışına aktarmaya yardım etme." (6) `ssh-firewall.sh` kural setinde `tcp dport 22` yerine `tcp dport { 22, 4180 }` kullanılır (aynı kaynak listeleri).

### Kopyalama engeli (Portal arayüzü)
- xterm: `rightClickSelectsWord:false`, seçim rengi saydam; `copy`, `cut`, `contextmenu`, `dragstart` olayları terminal kapsayıcısında `preventDefault`; `Ctrl/Cmd+C` (seçim varken), `Ctrl+Shift+C`, `Ctrl+Insert` tuşları yakalanıp yutulur (Ctrl+C kesme sinyali terminale normal gider); `user-select:none`. Yapıştırma (paste) İZİNLİDİR. Sayfa altında küçük uyarı: "Bu oturum kaydedilmektedir."
- Arayüzde dosya yükleme/indirme bileşeni YOK.

### Frontend
- Vite çok sayfalı: `index.html` (admin) + `portal.html` (portal) → `build.rollupOptions.input`. Portal kodu `frontend/src/portal/` altında ve yalnızca `src/core/ui.tsx`, `src/core/styles.css`'i kullanabilir; admin özelliklerini import ETMEZ. Geliştirme proxy'si: `/papi` → `http://127.0.0.1:4180` (ws dahil).
- Portal ekranları: Giriş (TOTP alanı `totp_required` gelince) → Parola değiştir (`change_password`) → TOTP kurulumu (`setup_totp`; secret + otpauth metni + kod) → Terminal (tam ekran; üst şeritte kullanıcı adı, bağlantı durumu, kalan süre, "Yeni oturum", "Çıkış"; açılış ipucu: `claude` yazarak ajanı başlatın).
- Admin yeni özellikler: `features/portal/` ("Portal hesapları": hesap oluştur/sıfırla → geçici parolayı BİR KEZ gösteren modal + kopyala; etkin/pasif; sil; API anahtarı ayarla/sil (parola alanı); ayarlar formu) ve `features/sessions/` ("Oturumlar": aktif/geçmiş sekmeleri, kullanıcı filtresi, canlı izle (salt okunur xterm, `/api/sessions/:id/watch`), oynat (cast'i indirip xterm'e zamanlamayla yazar; hız 1x/2x/8x, duraklat), sonlandır (onaylı), "Ajan kayıtları" (kullanıcı seç → dosya listesi → JSONL'i satır satır okunur biçimde göster: rol, araç adı, metin özeti)). Gates sayfasına "Ajan için Anthropic API izni" hazır düğmesi: egress=`allowlist`, egressAllow'a `160.79.104.0/23` ve `2607:6bc0::/48` ekler.

## EK-3: Takım Panosu, Geliştirme Günlüğü, Yönetici Notları, Marka

Marka: Portal'da "Gate Portal" geçen her yer (başlık, `portal.html` `<title>`, giriş ekranı) → **"KutGate Takım Çalışma Paneli"**. Kısa ad gerektiğinde "KutGate".

### Dizinler (`GATE_BOARD_DIR`, gerçek: `/var/lib/gate-board`, dry-run: `<DATA>/sandbox/board`)
```
<BOARD>/public/Geliştirme_notu.md        (servis kullanıcısı yazar, 0644)  → sandbox'ta /pano/Geliştirme_notu.md (ro)
<BOARD>/public/pano.md                   (0644)                            → /pano/pano.md (ro)
<BOARD>/users/<user>/yonetici_notlari.md (0644, dizin 0755)                → /pano/ben/yonetici_notlari.md (ro)
<BOARD>/inbox/<user>/                    (sahip <user>, grup = servis kullanıcısının birincil grubu, 2770) → /pano/gonder (rw)
```
`<BOARD>`, `public`, `users` servis kullanıcısına (`GATE_SERVICE_USER`, kurulumda verilir) aittir, 0755. Dosyalar her zaman atomik yazılır (aynı dizinde geçici dosya + `rename`). Dry-run'da backend dizinleri kendisi oluşturur.

### Veritabanı (yeni tablolar)
```
board_notes(id INTEGER PK AUTOINCREMENT, ts TEXT, author TEXT, author_kind TEXT CHECK(author_kind IN ('user','admin')), project TEXT, text TEXT)
dev_log(id INTEGER PK AUTOINCREMENT, ts TEXT, username TEXT, project TEXT, summary TEXT, files TEXT /*JSON dizi, göreli yollar, ≤50*/, file_count INTEGER, session_id TEXT, mode TEXT CHECK(mode IN ('claude','basic')))
admin_notes(id INTEGER PK AUTOINCREMENT, ts TEXT, target TEXT /*NULL = herkes, aksi halde username*/, title TEXT, text TEXT)
admin_note_reads(note_id INTEGER, username TEXT, read_ts TEXT, PRIMARY KEY(note_id, username))
```
`settings`: `devlog.interval_minutes=10` (1-120), `devlog.summarize=1` (0/1).

### Pano: kullanıcının ajanla not bırakması
- Ajan `/pano/gonder/` altına `*.md` veya `*.txt` dosyası yazar. Biçim: isteğe bağlı ilk satır `proje: <ad>` (`^[a-z][a-z0-9-]{1,31}$`), geri kalanı not metni.
- Portal süreci her 5 saniyede `<BOARD>/inbox/*/` dizinlerini tarar: yalnızca normal dosya (symlink değil), ≤ 4096 bayt, geçerli UTF-8, kontrol karakteri yok (`\n`, `\t` hariç). Yazar = inbox dizininin adı (kullanıcı adı) ve dizin sahibi uid'si o kullanıcıya eşit olmalı; değilse yok sayılır. Geçerli not `board_notes`'a (`author_kind='user'`) eklenir, dosya silinir; geçersiz dosya da silinir ve audit'e `board.reject` yazılır. Not metni 2000 karakterde kesilir. Audit: `board.note`.
- `pano.md` render: başlık `# Takım Panosu`, en yeni 200 not, yeniden eskiye: `## <YYYY-MM-DD HH:MM> · <yazar> (<kullanıcı|yönetici>) · <proje veya "genel">` + metin. Saat Europe/Istanbul.

### Geliştirme günlüğü (10 dakikada bir, otomatik)
- Portal süreci, aktif terminal oturumu olan her kullanıcı için oturum başlangıcından itibaren `interval_minutes`'te bir ve oturum bittiğinde bir kez "tick" çalıştırır. Kullanıcı başına son tick zamanı bellekte tutulur (`since`).
- Tick adımları:
  1. `sudo -n <SCRIPTS_DIR>/dev-changes.sh <user> <since_epoch>` → tek satır JSON: `{"ok":true,"projects":[{"name":"demo","count":3,"files":["backend/app.py",...]}]}` (dosya listesi proje başına ≤50, göreli yol).
  2. Ajan etkinliği: `agent-logs.sh <user> list` ile `since` sonrası değişen `.jsonl` dosyaları okunur (`read`); `timestamp >= since` olan kayıtlardan yalnızca kullanıcı mesaj metinleri ve asistan metin yanıtları (araç girdileri/çıktıları HARİÇ) alınır, toplam ≤ 12000 karakter (sondan kırpılır).
  3. Hiç dosya değişikliği VE hiç ajan etkinliği yoksa kayıt yazılmaz.
  4. Özet: `devlog.summarize=1` ise `execFile(GATE_CLAUDE_BIN, ['-p', prompt, '--tools', ''])`, 90 sn zaman aşımı. Prompt: "Aşağıdaki geliştirme oturumunu takım arkadaşları için Türkçe, en fazla 2 cümle, kısa ve net özetle. Ne yapıldığını ve hangi bölümde yapıldığını söyle. Kesinlikle kod, dosya içeriği, komut, gizli bilgi yazma. Yalnızca özeti yaz." + kullanıcı adı + değişen dosya listesi + sohbet metni. Çıktı: tek paragraf, ≤ 400 karakter, ``` içeriyorsa veya boşsa reddedilir. Başarısızsa `mode='basic'`: "<N> dosyada değişiklik: <ilk 5 dosya>" (ajan etkinliği var ama dosya değişikliği yoksa: "Ajanla çalışıldı, dosya değişikliği yok.").
  5. Değişiklik olan her proje için bir `dev_log` satırı (dosya değişikliği yoksa `project='genel'` tek satır). Audit: `devlog.write`.
  6. `Geliştirme_notu.md` render: başlık `# Geliştirme Notu`, açıklama satırı "Bu dosya oturumlardan 10 dakikada bir otomatik oluşturulur.", en yeni 300 kayıt, yeniden eskiye: `## <YYYY-MM-DD HH:MM> · <kullanıcı> · proje: <proje>` + özet + `Değişen dosyalar (<N>): a, b, c` (en fazla 10 ad, fazlası "+K"). Saat Europe/Istanbul.
- Tick'ler sıralı çalışır (aynı anda tek tick), hata olursa sonraki tick'te tekrar denenir; `since` yalnızca başarılı tick'te ilerler.

### Yönetici notları
- Admin bir not oluşturur: herkese (`target=NULL`) ya da tek kullanıcıya. Her oluşturma/silmede ilgili kullanıcıların `yonetici_notlari.md` dosyası yeniden render edilir (herkese not → tüm portal hesabı olan kullanıcılar).
- `yonetici_notlari.md`: başlık `# Yönetici Notları`, o kullanıcıya görünen notlar (herkese + kendisine), yeniden eskiye: `## <tarih saat> · <başlık> [OKUNMADI]` (okunmamışsa) + metin.

### Root script (yeni, whitelist + install/sudoers listesine eklenir)
- `dev-changes.sh <user> <since_epoch>`: `since_epoch` = `^[0-9]{1,12}$`. Kullanıcının projeleri `portal-shell.sh` ile aynı yöntemle belirlenir (mod-<ad> grubu → rw; ACL `user:<user>:r-x` → r). Her proje için `find <dir> -xdev -type f -newermt @<since> -not -path '*/.git/*' -not -path '*/node_modules/*' -printf '%P\n'` (symlink izlemez), sıralı, ≤50 + toplam sayı. JSON güvenli kaçışla üretilir (dosya adlarında `"`, `\`, kontrol karakterleri kaçırılır; geçersiz UTF-8 içeren adlar atlanır).
- `portal-shell.sh` eki: sandbox başlatılmadan önce `<BOARD>/inbox/<user>` yoksa oluşturur (sahip user, grup servis kullanıcısının birincil grubu, 2770; symlink reddi), `<BOARD>/users/<user>` yoksa oluşturur (servis kullanıcısı sahibi, 0755). Ek bind'ler: `-p TemporaryFileSystem=/pano:ro`, `-p BindReadOnlyPaths=-<BOARD>/public/Geliştirme_notu.md:/pano/Geliştirme_notu.md`, `-p BindReadOnlyPaths=-<BOARD>/public/pano.md:/pano/pano.md`, `-p BindReadOnlyPaths=-<BOARD>/users/<user>:/pano/ben`, `-p BindPaths=<BOARD>/inbox/<user>:/pano/gonder`. Servis kullanıcısı adı `/etc/gate/service-user` dosyasından okunur (install.sh yazar, root 0644, tek satır).
- `install.sh` eki: `<BOARD>`, `public`, `users`, `inbox` dizinleri (servis kullanıcısı sahibi, 0755; `inbox` root:root 0755), boş `Geliştirme_notu.md` ve `pano.md` (yoksa; servis kullanıcısı sahibi 0644), `/etc/gate/service-user`.

### HTTP API
**Portal (`/papi`, giriş + `stage=ready` gerekir):**
- `GET /papi/devlog?project=&limit=100` → `[{id,ts,username,project,summary,fileCount,files}]` (≤300)
- `GET /papi/board?limit=100` → `[{id,ts,author,authorKind,project,text}]`
- `GET /papi/admin-notes` → `[{id,ts,title,text,toAll:boolean,read:boolean}]` (yalnızca herkese + bu kullanıcıya)
- `POST /papi/admin-notes/:id/read` → `{ok}` (yalnızca kendisine görünen not); okundu sonrası `yonetici_notlari.md` yeniden render
- `GET /papi/status` yanıtına `unreadAdminNotes:number` eklenir.
**Admin (`requireAuth`, yeni modül `board`):**
- `GET /api/devlog?user=&project=&limit=` · `DELETE /api/devlog/:id` (render)
- `GET /api/devlog/settings` · `PUT /api/devlog/settings {intervalMinutes, summarize}`
- `GET /api/board` · `POST /api/board {text (1-2000), project?}` (`author='yönetici'`, `author_kind='admin'`) · `DELETE /api/board/:id` (render)
- `GET /api/admin-notes` → `[{id,ts,target,title,text,reads:[{username,readTs}]}]` · `POST /api/admin-notes {target: null|username, title (1-120), text (1-4000)}` (target varsa portal hesabı olmalı) · `DELETE /api/admin-notes/:id`
Tüm metinler düz metin olarak saklanır ve arayüzde metin olarak gösterilir (HTML olarak işlenmez). Portal ve admin süreçleri render için aynı `core/board.ts` fonksiyonlarını kullanır.

### Arayüz
**Portal üst şerit** (kullanıcı adı · bağlantı · kalan süre şeridi): iki yeni düğme:
- **"Geliştirme günlüğü"** → modal, iki sekme: "Geliştirme notu" (proje filtresi, kayıt listesi: tarih saat · kullanıcı · proje · özet · değişen dosya sayısı, dosya adları açılır/kapanır) ve "Pano" (not listesi, yazar rozeti kullanıcı/yönetici). Yenile düğmesi.
- **"Yönetici notu"** (okunmamış sayısı rozeti) → modal: notlar yeniden eskiye, "herkese"/"size özel" rozeti, okunmamışlar vurgulu, her notta "Okundu" düğmesi. Portal açılışında okunmamış not varsa düğme dikkat çekici (rozet + nabız animasyonu yok, yalnızca renk; reduced-motion uyumlu).
- Modallarda metin seçme/kopyalama SERBEST (bunlar kod değil), terminal kopyalama engeli aynen kalır.
**Admin yeni menüler** (`features/board/`): "Geliştirme Notları" (filtre: kullanıcı, proje, tarih; tablo; sil; ayarlar: aralık dakika, özetleme açık/kapalı), "Takım Panosu" (liste, sil, yönetici olarak not ekle), "Yönetici Notları" (yeni not formu: hedef "Tüm kullanıcılar" veya kullanıcı seçimi, başlık, metin; gönderilenler listesi ve her not için kimlerin okuduğu; sil).

## EK-4: Tek adres (GATE_PORTAL_HOSTNAME), ortak giriş, ters vekil, kalıcı servisler

Amaç: dışarıdan yalnızca `https://<GATE_PORTAL_HOSTNAME>` (ör. Cloudflare tüneli → `http://localhost:4180`, Portal). Admin sunucusu `127.0.0.1:4173`'te kalır; dışarıdan Portal üzerinden vekil ile erişilir.

### Yol düzeni (tek köken)
- `/` ve bilinmeyen GET'ler → `portal.html` (Portal SPA). `/assets/*` → `frontend/dist/assets` (Portal ve Admin aynı varlık klasörünü kullanır).
- `/papi/*` → Portal uçları (değişmez).
- `/admin` → 301 `/admin/`; `/admin/*` ve `/api/*` (HTTP + WebSocket) → Portal içinde **ters vekil** ile `http://127.0.0.1:<GATE_PORT>`'a aktarılır.
- Admin sunucusu: Admin SPA'yı `/admin/` altında sunar (`frontend/dist/admin/index.html`; `/admin/` altındaki bilinmeyen GET → bu dosya). `/` → 302 `/admin/`. `/assets/*` admin sunucusunda da sunulur (yerel erişim için).

### Ters vekil (Portal, `backend/src/portal/proxy.ts`, yeni paket YOK — `node:http` + `node:net`)
- Yöntem, yol + sorgu, gövde (akış olarak) ve başlıklar aynen iletilir; `Host` ve `Origin` DEĞİŞTİRİLMEZ (admin'in Origin kontrolü `Origin` host'u ile `Host` başlığını karşılaştırır). Hop-by-hop başlıklar (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade` — WS hariç) temizlenir. `x-forwarded-for` (gerçek istemci IP'si eklenir), `x-forwarded-proto` (istekteki `x-forwarded-proto` ya da `cf-visitor`'dan, yoksa `http`), `x-gate-proxied: 1` eklenir.
- WebSocket: `upgrade` olayında `/api/` ile başlayan istekler için `net.connect(GATE_PORT,'127.0.0.1')` açılır, istek satırı ve başlıklar yazılır, iki soket karşılıklı borulanır; hata/kapanışta ikisi de yok edilir. Portal'ın kendi WS uçları (`/papi/terminal`) etkilenmez.
- Admin sunucusuna ulaşılamazsa 502 `{error:'admin_unavailable'}`. Zaman aşımı: HTTP 60 sn (WS hariç).
- Vekil yalnızca `/admin`, `/admin/*`, `/api/*` önekleri için çalışır; başka hiçbir yolu iletmez.

### Gerçek istemci IP'si (her iki sunucu)
- Bağlantı `127.0.0.1`/`::1`'den geliyorsa: önce `cf-connecting-ip`, yoksa `x-forwarded-for`'un ilk değeri, istemci IP'si kabul edilir (geçerli IPv4/IPv6 değilse yok sayılır). Aksi halde soket adresi. Hız sınırı anahtarları ve audit `ip=` bu değeri kullanır. (Fastify `trustProxy` fonksiyonu ile ya da ortak `core/clientip.ts`.)

### Ortak giriş (`POST /papi/login`)
- Kullanıcı adı (küçük harfe çevrilmiş, kırpılmış) `admins` tablosunda varsa → **yönetici akışı**: parola doğrulanır (kırpılmış deneme kuralı portal ile aynı). Yönetici TOTP'si etkin DEĞİLSE 403 `{error:'admin_totp_setup_required'}` (yönetici önce yerel admin panelinden TOTP'yi açmalı). TOTP etkinse `totp` zorunlu (`totp_required`), doğrulanır. Başarıda admin oturumu `sessions` tablosunda, admin ile AYNI kurallarla (`core/auth.ts` fonksiyonları) oluşturulur, `gate_sid` çerezi (httpOnly, sameSite=strict, path=/, istek HTTPS ise `secure`) yazılır, yanıt `{ok:true, stage:'admin', redirect:'/admin/'}`. Audit: `auth.login` (actor = yönetici adı, detay `ip=... via=portal`). Hız sınırı portal ile aynı sayaçta.
- Kullanıcı adı yönetici değilse mevcut portal akışı aynen.
- Kullanıcı oluşturmada (`POST /api/users`) ad bir yönetici adıyla aynıysa 409 `{error:'name_reserved'}`.
- Portal çerezi `gate_psid` da istek HTTPS ise `secure` olur. HTTPS tespiti: `x-forwarded-proto: https` ya da `cf-visitor` içinde `"scheme":"https"` (yalnızca bağlantı 127.0.0.1'den geliyorsa güvenilir).

### Admin girişsiz erişim
- Admin SPA, `/api/auth/status` `loggedIn:false` ise ve sayfa `x-gate-proxied` üzerinden (yani `/admin/` dış adresten) açılmışsa kendi giriş formu yerine `/`'e (ortak giriş) yönlendirir. Bunu admin sunucusu `GET /api/auth/status` yanıtına `viaProxy:boolean` (istekte `x-gate-proxied: 1` var mı) ekleyerek bildirir. Yerel (`127.0.0.1:4173`) erişimde admin'in kendi giriş/kurulum formu aynen kalır. `needsSetup` (hiç yönetici yok) iken vekil üzerinden kurulum YAPILAMAZ: `POST /api/auth/setup` isteği `x-gate-proxied: 1` taşıyorsa 403.
- Admin'de "Çıkış" sonrası vekil üzerinden açıldıysa `/`'e döner.

### Frontend derleme düzeni
- Admin giriş noktası `frontend/admin/index.html` (mevcut `index.html` buraya taşınır), Vite `build.rollupOptions.input = { portal: 'portal.html', admin: 'admin/index.html' }`, `base: '/'`. Çıktı: `dist/portal.html`, `dist/admin/index.html`, `dist/assets/*`. Admin'deki tüm API çağrıları kök göreli (`/api/...`) kalır. Admin içi yönlendirme hash tabanlı kalır. Geliştirme proxy'si: `/api` → 4173, `/papi` → 4180.
- Portal giriş ekranı: `stage:'admin'` yanıtında `window.location.assign(redirect)`. `admin_totp_setup_required` hatasında: "Yönetici girişi için önce yerel admin panelinden iki adımlı doğrulamayı (TOTP) etkinleştirin." mesajı.

### Kalıcı servisler (`scripts/install.sh` eki)
- `/etc/systemd/system/gate-admin.service` ve `gate-portal.service`: `User=<GATE_SERVICE_USER>`, `WorkingDirectory=/srv/gate/backend`, `Environment=GATE_DRY_RUN=0 GATE_DATA_DIR=/srv/gate/data-real NODE_ENV=production`, `ExecStart=<node mutlak yolu> /srv/gate/backend/node_modules/tsx/dist/cli.mjs src/server.ts` (portal için `src/portal.ts`), `Restart=on-failure`, `RestartSec=3`, `After=network-online.target`, `WantedBy=multi-user.target`, `NoNewPrivileges` YOK (sudo gerekir). Node yolu `GATE_NODE_BIN` env'inden, yoksa `/home/<servis>/.nvm/versions/node/*/bin/node` içindeki en yüksek sürüm; bulunamazsa kurulum durur. Birimler yazılır, `daemon-reload`, `enable` edilir ama BAŞLATILMAZ (geçişte eski nohup süreçleri önce durdurulmalı; INSTALL.md'de anlatılır: `sudo systemctl start gate-admin gate-portal`).
- `cloudflared` kurulumu bu betikte YOK (token'ı yönetici kendisi `cloudflared service install` ile kurar); INSTALL.md'ye kurulum adımları yazılır: Cloudflare apt deposundan `cloudflared` paketi, sonra `sudo cloudflared service install <TOKEN>`.

## EK-5: Skill Stüdyosu yalıtımı ve "Tüm kullanıcılar" hedefi

### Yalıtılmış claude çağrısı (Skill Stüdyosu `generate` ve geliştirme günlüğü özeti)
Tüm `claude -p` çağrıları ortak bir `core/claudeRun.ts` fonksiyonuyla yapılır:
- Argümanlar: `['-p', prompt, '--setting-sources', '', '--tools', '', '--no-session-persistence']`.
- Ortam: `process.env` + `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- `cwd`: her çağrı için `<DATA_DIR>/tmp/claude-<rastgele>` (0700) boş dizini; çağrı bitince (`finally`) silinir.
- Zaman aşımı parametre olarak (skill 120 sn, günlük 90 sn), `killSignal: 'SIGKILL'`, `maxBuffer` 1 MB.
Böylece yönetici hesabının kişisel `CLAUDE.md`, ayar, hook, hafıza ve skill'leri üretime karışmaz.
Skill üretim prompt'una şu cümle eklenir: "Bu skill, sunucudaki takım üyelerinin (Portal kullanıcıları) kendi Claude Code oturumlarında kullanılacak; yönetici/şef/alt ajan/model seçimi gibi yönetici iş akışı kavramlarını ekleme, yalnızca kaynak metindeki amaca odaklan."

### "Tüm kullanıcılar" hedefi
- `targetUser` artık kullanıcı adı ya da `'*'` (tüm kullanıcılar) olabilir. Kurallar:
  - `targetKind:'rules'` + `'*'` → `global` olarak kaydedilir (`<RULES_ROOT>/global/skills/<name>/SKILL.md`, `target_kind='global'`, `target_user=NULL`). Yeni kullanıcılar da otomatik kapsanır.
  - `targetKind:'home'` + `'*'` → `target_kind='home'`, `target_user='*'`; kayıt/güncellemede o an portal hesabı olan VE olmayan tüm kullanıcıların (`users` tablosu) `<HOME_ROOT>/<user>/.claude/skills/<name>/SKILL.md` dosyasına yazılır; silmede hepsinden silinir. Yazma hatası olan kullanıcılar yanıtta `failed:[username]` olarak döner, kayıt yine oluşur.
  - `POST /api/skills/:id/sync` (yalnızca `home` + `'*'`): dosyayı mevcut tüm kullanıcılara yeniden yazar → `{ok, written, failed:[]}`.
  - Kullanıcı oluşturulduğunda (`POST /api/users` başarılı olunca), `home` + `'*'` skill'ler o kullanıcıya da yazılır (skills modülü bunu `core` üzerinden yayınlanan bir `user.created` olayıyla yapar; modüller birbirini import etmez — gerekiyorsa `core/events.ts` basit bir olay yayıcı).
- `GET /api/skills` yanıtında `targetUser` `'*'` olabilir; `global` olanlar `targetUser:null`.
- Aynı ad + hedef çakışması kuralı korunur (`UNIQUE(name,target_kind,target_user)`).

### Arayüz (Skill Stüdyosu)
- Hedef seçimi iki adım: **Tür**: "Kullanıcı kuralları (yönetici, kullanıcı değiştiremez)" (`rules`) / "Kullanıcının kişisel skill klasörü (kullanıcı düzenleyebilir)" (`home`). **Kullanıcı**: açılır listede ilk seçenek **"Tüm kullanıcılar"**, ardından kullanıcılar. Ayrı "global" türü seçeneği arayüzden kaldırılır (rules + Tüm kullanıcılar onun yerine geçer); mevcut global kayıtlar listede "Kullanıcı kuralları · Tüm kullanıcılar" olarak görünür.
- Listede hedef sütunu: "<tür> · <kullanıcı veya Tüm kullanıcılar>". `home` + `'*'` kayıtlarında "Yeniden uygula" düğmesi (`/sync`), sonuçta yazılan/başarısız sayısı.
- Düzenleme ekranında hedef değiştirilebilir: hedef değişirse istemci önce yeni hedefe `POST /api/skills` (aynı ad/içerik) yapar, başarılıysa eskisini `DELETE` eder; hata olursa eski kayıt korunur.

## EK-6: Portal terminali kopma sonrası devam (ekran kilidi / ağ değişimi)

### Sunucu (portal süreci)
- WebSocket kapandığında terminal süreci HEMEN sonlandırılmaz: oturum **"bağlantısız"** duruma geçer ve `GRACE` süresi (settings `portal.detach_minutes`, varsayılan 15, aralık 1–120) boyunca canlı tutulur. Bu sürede pty çıktısı okunmaya devam eder ve kayıt (cast) yazılmaya devam eder; ayrıca bellekte oturum başına son **256 KB** çıktı halka tampon olarak tutulur.
- Boşta (idle) ve en uzun (max) süre sayaçları bağlantısız durumda da işler; `GRACE` dolarsa `end_reason='detached_timeout'` ile sonlandırılır. Admin "sonlandır" ve kullanıcı çıkışı (logout) bağlantısız oturumları da kapatır (logout'ta kullanıcının tüm oturumları `'logout'`).
- Yeniden bağlanma: `GET /papi/terminal?resume=<id>` (WebSocket). Koşullar: `id` `^[a-f0-9]{24}$`, oturum bu kullanıcıya ait, canlı ve şu an bağlı bir istemcisi yok. Koşullar sağlanırsa yeni WebSocket o oturuma bağlanır: önce sunucu tek bir JSON kontrol mesajı gönderir `{"t":"resumed","id":"<id>"}`, ardından halka tampondaki çıktı gönderilir (istemci terminali temizleyip tamponu yazar), sonra canlı akış sürer; istemcinin ilk resize mesajı pty'ye uygulanır. Koşullar sağlanmazsa (bulunamadı/başkasının/bitmiş) yeni oturum açılır ve ilk mesaj `{"t":"new","id":"<yeni id>"}` olur. Aynı oturuma ikinci bir istemci bağlanmaya çalışırsa eski bağlantı `4000 'replaced'` koduyla kapatılır ve yeni bağlantı devralır (sekme yenileme senaryosu).
- Yeni oturumlarda da ilk mesaj `{"t":"new","id":"<id>"}`. (Bu iki JSON mesajı dışında sunucu→istemci akışı ham metin olmaya devam eder; istemci yalnızca ilk mesajı JSON olarak ayrıştırmayı dener.)
- `max_concurrent` sayımına bağlantısız oturumlar da dahildir; sınır doluysa ve kullanıcının bağlantısız oturumu varsa `resume` parametresi olmadan gelen istek en eski bağlantısız oturuma bağlanır (yeni açmaz).
- Audit: `portal.terminal.detach` (id), `portal.terminal.resume` (id). `term_sessions` satırı yalnızca gerçek bitişte kapanır.
- Admin `GET /api/sessions` yanıtında `live` olanlar için `attached:boolean` alanı (dahili `/internal/live` yanıtı `[{id, attached}]` olarak genişler; geriye dönük: dizi elemanı string ise attached=true say).
- `GET /papi/status` yanıtına `detachMinutes` eklenir; admin `GET/PUT /api/portal/settings` gövdesine `detachMinutes` eklenir.

### İstemci (Portal terminal sayfası)
- Oturum kimliği `sessionStorage['kg_term_id']`'de tutulur (ilk `new`/`resumed` mesajından). Bağlanırken varsa `?resume=<id>` eklenir.
- Otomatik yeniden bağlanma: WebSocket beklenmedik kapanırsa (kod 1000/4000 ve kullanıcı "Yeni oturum"/"Çıkış" demediyse) üstel bekleme ile (1 sn, 2 sn, 4 sn … en çok 15 sn) otomatik yeniden dener; `document.visibilitychange` (görünür olunca), `online` ve `pageshow` olaylarında hemen dener. Bu sırada üst şeritte "Yeniden bağlanıyor…" durumu; başarılı `resumed` sonrası "Bağlı". Manuel "Yeniden bağlan" düğmesi yalnızca 5 başarısız denemeden sonra görünür.
- `resumed` geldiğinde terminal `reset()` edilir, ardından gelen tampon yazılır, `fit()` + resize gönderilir.
- "Yeni oturum" düğmesi: mevcut oturumu sonlandırmak için sunucuya `{"t":"end"}` kontrol mesajı gönderir (sunucu bunu `end_reason='closed'` ile kapatır), `sessionStorage` kimliğini siler ve `resume` olmadan bağlanır.
