# Gate kurulumu (install.sh)

Gereksinim: acl paketi (`apt install acl`). `setfacl` yoksa `install.sh` hiçbir değişiklik yapmadan durur.

`/srv/gate/scripts/install.sh` şunları yapar:

1. `GATE_REAL=1` verilmemişse hiçbir şey yapmadan hata ile çıkar.
2. root olarak çalıştığını ve `GATE_SERVICE_USER` (zorunlu) kullanıcısının var olduğunu doğrular.
3. `scripts/gate-shell.sh` dosyasını `/usr/local/sbin/gate-shell` olarak kurar (root:root, 755).
4. `/usr/local/lib/gate/` dizinini temizleyip yeniden oluşturur (root:root, 755) ve aşağıdaki script'leri oraya kopyalar (root:root, 755). Symlink olan kaynak veya hedef reddedilir.
5. `/etc/gate/protected-users` dosyası yoksa oluşturur (root:root, 644; içerik: `root` ve `GATE_SERVICE_USER`). Dosya varsa dokunmaz. Biçim: satır başına bir kullanıcı adı, `#` sonrası yorum. Root script'leri korunan kullanıcı listesini bu dosyadan okur; dosya yoksa, symlink ise veya root sahipliğinde değilse işlem reddedilir.
6. `/etc/sudoers.d/gate` dosyasına yalnızca şu script'ler için `/usr/local/lib/gate/<ad>.sh` tam yollu `NOPASSWD` satırları yazar (root:root, 440):
   `user-add user-del user-lock key-add key-del module-add module-del grant revoke egress-profile rules-init file-write file-delete portal-shell session-kill portal-mode apikey-set agent-logs dev-changes`
7. Dosyayı önce `visudo -c -f`, yerine koyduktan sonra `visudo -c` ile doğrular; başarısızsa dosyayı kaldırır.
8. Aynı içeriği `docs/sudoers.d-gate.example` olarak yazar.
9. Başarıda tek satır `{"ok":true}` basar; hata stderr'e yazılır, çıkış kodu ≠ 0.

`/srv/gate/scripts` altındaki script'ler değiştirildiğinde `install.sh` yeniden çalıştırılmadıkça `/usr/local/lib/gate` altındaki kopyalar güncellenmez.

## Lisans

KutGate lisanslı yazılımdır (bkz. kökteki `LICENSE`). Gerçek kurulumda (`GATE_DRY_RUN=0`) admin ve Portal
servisleri açılışta `/etc/gate/license.key` dosyasını doğrular; dosya yoksa, imzası geçersizse ya da süresi
dolmuşsa servis **başlamaz**. Lisans dosyasını lisans verenden alırsınız; kurulumda `GATE_LICENSE_SRC` ile verilir.

## Çalıştırma

Kuruma özel hiçbir değer kodda yoktur; hepsi kurulumda verilir ve `/etc/gate/gate.env` dosyasına yazılır
(systemd `EnvironmentFile`). Sonradan değiştirmek için bu dosyayı düzenleyip servisleri yeniden başlatın.

```
sudo GATE_REAL=1 \
     GATE_SERVICE_USER=<servis_kullanicisi> \
     GATE_LICENSE_SRC=/yol/lisans.key \
     GATE_PORTAL_HOSTNAME=gate.ornek.com \
     GATE_TEAM_NAME="Ornek Takimi" \
     GATE_SSH_ALLOW_V4="10.0.0.0/8 192.168.1.0/24" \
     bash /srv/gate/scripts/install.sh
```

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `GATE_SERVICE_USER` | evet | Servislerin çalıştığı sistem kullanıcısı (önceden açılmış olmalı). |
| `GATE_LICENSE_SRC` | ilk kurulumda | Lisans dosyası; `/etc/gate/license.key` olarak kopyalanır. |
| `GATE_PORTAL_HOSTNAME` | evet | Portalın dışarıdan açıldığı ad (ör. `gate.ornek.com`). |
| `GATE_PREVIEW_DOMAIN` | hayır | Önizleme alt alan adlarının kökü (`onizle-<kullanıcı>.<alan>`). Verilmezse önizleme KAPALI. |
| `GATE_GITHUB_ORG` | hayır | Git gönderiminde izinli GitHub hesabı. Verilmezse yeni depo bağlanamaz. |
| `GATE_TEAM_NAME` | hayır | Takım sayfasındaki ad (varsayılan `Takım`). |
| `GATE_SSH_ALLOW_V4` | hayır | SSH ve Portal'a izinli ağlar (boşlukla ayrılmış CIDR). İlk kurulumda `/etc/gate/ssh-allow-v4`'e yazılır; IPv6 için `/etc/gate/ssh-allow-v6` elle doldurulur. Liste boşsa `ssh-firewall.sh` kural yazmaz. |
| `GATE_SHARED_APPS` | hayır | Portal arkasından yayınlanan uygulamalar, JSON, tek tırnak içinde: `GATE_SHARED_APPS='[{"project":"ad","host":"app.ornek.com","port":5010}]'` — `/etc/gate/gate.env`'e elle eklenir. |

Kurulumdan sonra backend'i gerçek modda çalıştırmak için `GATE_DRY_RUN=0` verilir. Bu modda `GATE_SCRIPTS_DIR` verilmemişse varsayılan `/usr/local/lib/gate` olur (dry-run'da `/srv/gate/scripts`).

## Portal

Gereksinimler: systemd ≥ 250, acl paketi (`apt install acl`).

`install.sh` Portal için ayrıca şunları kurar (tekrar çalıştırılabilir):

1. `gate-portal` grubu (yoksa oluşturulur).
2. `/etc/ssh/sshd_config.d/gate-00-portal.conf` (root:root, 644), içerik `DenyGroups gate-portal`: Portal modundaki kullanıcılar SSH ile giriş yapamaz. `sshd -t` başarısızsa dosya eski haline getirilir (yoksa kaldırılır) ve kurulum durur; başarılıysa `systemctl reload ssh`.
3. `/etc/gate/keys` dizini (root:root, 700): kullanıcı başına Anthropic API anahtarı `<kullanıcı>.key` (root:root, 600).
4. `claude` ikili dosyası: `GATE_CLAUDE_SRC` (varsayılan `readlink -f /home/<GATE_SERVICE_USER>/.local/bin/claude`) kaynağından `/usr/local/bin/claude` olarak (root:root, 755) kopyalanır.
5. `/etc/claude-code/CLAUDE.md` (root:root, 644): yoksa yazılır, varsa dokunulmaz. İçerik: önce `/opt/claude-rules/global/`, sonra `/opt/claude-rules/users/$USER/` kurallarını oku ve uy; yalnızca `/srv/projects/` altında açılmış klasörlerde çalış; dosya içeriklerini sunucu dışına aktarmaya yardım etme.
6. Yeni root script'leri `/usr/local/lib/gate/` altına kopyalanır ve sudoers'a eklenir: `portal-shell session-kill portal-mode apikey-set agent-logs`.

`ssh-firewall.sh` kural seti 22 ve 4180 (Portal) portlarını aynı kaynak listeleriyle (Tailscale + yerel ağ) açar: `tcp dport { 22, 4180 }`. Değişikliğin etkinleşmesi için `ssh-firewall.sh apply` ve ardından `keep` yeniden çalıştırılır.

Kullanıcının egress profili Anthropic API aralığına (`160.79.104.0/23`, `2607:6bc0::/48`) izin vermelidir: egress `allowlist` ve bu iki aralık listede (Gates sayfasındaki "Ajan için Anthropic API izni" düğmesi) ya da egress `open`. Aksi halde `claude` API'ye bağlanamaz.

Portal terminali `portal-shell.sh` ile `systemd-run --pty` altında, kullanıcının hesabıyla ve sandbox içinde açılır: `/srv` boş tmpfs olur, yalnızca yetki verilen `/srv/projects/<ad>` klasörleri (rw veya salt okunur) bağlanır; ağ erişimi localhost ve Anthropic aralığıyla sınırlıdır.

## Takım panosu ve geliştirme günlüğü

`install.sh` ayrıca şunları kurar (tekrar çalıştırılabilir):

1. `/etc/gate/service-user` (root:root, 644): tek satır, `GATE_SERVICE_USER` adı. Her kurulumda atomik yeniden yazılır. `portal-shell.sh` servis kullanıcısını bu dosyadan okur; dosya yoksa, symlink ise, root sahipliğinde değilse veya ad geçersizse terminal açılmaz.
2. `/var/lib/gate-board`, `public`, `users` (servis kullanıcısı sahibi, 755) ve `inbox` (root:root, 755) dizinleri.
3. `public/Geliştirme_notu.md` ve `public/pano.md` (yoksa boş; servis kullanıcısı sahibi, 644).
4. `dev-changes` script'i `/usr/local/lib/gate/` altına kopyalanır ve sudoers'a eklenir.

`portal-shell.sh` terminali açmadan önce `inbox/<kullanıcı>` (sahip kullanıcı, grup servis kullanıcısının birincil grubu, 2770) ve `users/<kullanıcı>` (servis kullanıcısı sahibi, 755) dizinlerini yoksa oluşturur. Sandbox içinde `/pano` salt okunur tmpfs olur: `Geliştirme_notu.md`, `pano.md`, `ben/` (yönetici notları) salt okunur; `gonder/` (kullanıcının inbox'ı) yazılabilir.

`dev-changes.sh <kullanıcı> <since_epoch>` kullanıcının erişebildiği proje klasörlerinde `since_epoch` sonrası değişen dosyaları (`.git` ve `node_modules` hariç, proje başına en fazla 50 ad + toplam sayı) tek satır JSON olarak verir. `python3` gerektirir.

## Kalıcı servisler (systemd)

`install.sh` ayrıca şunları yapar (tekrar çalıştırılabilir; birim dosyaları her kurulumda atomik yeniden yazılır):

1. Node yolu: `GATE_NODE_BIN` verilmişse o; yoksa `/home/<GATE_SERVICE_USER>/.nvm/versions/node/*/bin/node` içindeki en yüksek sürüm. Bulunamazsa kurulum hiçbir değişiklik yapmadan durur.
2. `/etc/systemd/system/gate-admin.service` ve `/etc/systemd/system/gate-portal.service` (root:root, 644): `User=<GATE_SERVICE_USER>`, `WorkingDirectory=/srv/gate/backend`, `Environment=GATE_DRY_RUN=0 GATE_DATA_DIR=/srv/gate/data-real NODE_ENV=production`, `ExecStart=<node> /srv/gate/backend/node_modules/tsx/dist/cli.mjs src/server.ts` (portal için `src/portal.ts`), `Restart=on-failure`, `RestartSec=3`, `After=network-online.target`, `WantedBy=multi-user.target`.
3. `gate-egress.service` ve `gate-lo-guard.service` (tek seferlik): açılışta `/etc/gate/egress.nft` ve `/etc/gate/lo-guard.nft` ağ kısıtlarını yeniden yükler; kural dosyası yoksa çalışmaz.
4. `systemctl daemon-reload` ve `systemctl enable gate-admin gate-portal gate-egress gate-lo-guard`. Servisler BAŞLATILMAZ.

Yeniden çalıştırıldığında (güncelleme) `install.sh` mevcut `/etc/gate/gate.env` değerlerini korur; yalnız yeniden verilen değişken değişir.

Farklı node yolu için:

```
sudo GATE_REAL=1 GATE_NODE_BIN=/tam/yol/node bash /srv/gate/scripts/install.sh
```

### Elle çalışan süreçlerden servislere geçiş

1. Elle (`nohup`) başlatılmış admin ve portal süreçlerini bulun:

   ```
   pgrep -af 'src/(server|portal)\.ts'
   ```

2. Listelenen süreçleri durdurun ve kapandıklarını doğrulayın (komut bir şey listelememeli):

   ```
   kill <PID> <PID>
   pgrep -af 'src/(server|portal)\.ts'
   ```

3. Servisleri başlatın:

   ```
   sudo systemctl start gate-admin gate-portal
   ```

4. Durumu ve kayıtları kontrol edin:

   ```
   systemctl status gate-admin gate-portal
   journalctl -u gate-admin -u gate-portal -f
   ```

Admin sunucusu `127.0.0.1:4173`, Portal `GATE_PORTAL_HOST:4180` üzerinde dinler. Portal; `/admin`, `/admin/*` ve `/api/*` isteklerini (WebSocket dahil) admin sunucusuna ters vekil ile aktarır.

## Cloudflare tüneli (cloudflared)

`install.sh` cloudflared kurmaz. Tünel, `https://<GATE_PORTAL_HOSTNAME>` adresini `http://localhost:4180` (Portal) adresine yönlendirir; yönetici bunu Cloudflare panelinde tünelin genel ana makine adı (public hostname) olarak tanımlar.

1. Cloudflare apt deposunu ekleyin ve `cloudflared` paketini kurun:

   ```
   sudo mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update
   sudo apt-get install cloudflared
   ```

2. Tüneli servis olarak kurun (`<TOKEN>`: Cloudflare panelindeki tünel token'ı):

   ```
   sudo cloudflared service install <TOKEN>
   ```

Token gizlidir; hiçbir dosyaya, betiğe, notlara veya kayda yazılmaz. Kabuk geçmişine ve `sudo` kaydına (komut satırı `COMMAND=` olarak loglanır) düşmemesi için token'ı ekrana yazdırmadan okuyup root kabuğunda kullanın:

```
sudo -s
read -rs CF_TOKEN
cloudflared service install "$CF_TOKEN"
unset CF_TOKEN
exit
```

Kurulumdan sonra: `systemctl status cloudflared`.

## Bilinen sınırlar

- Portal'da kopyalama engeli yalnızca tarayıcı tarafındadır: ekran görüntüsü almak veya içeriği elle yazmak engellenemez.
- Portal kullanıcısı kendi API anahtarını oturum içinde görebilir (anahtar oturuma systemd credential olarak verilir).
- `gate-shell` yalnızca komutun ilk kelimesine bakarak `scp`/`sftp-server`/`internal-sftp`/`rsync` komutlarını reddeder. `bash -c '...'` gibi sarmalayıcılarla bu ret aşılabilir; dosya kopyalamayı tamamen engellemez.
- Kaynak koda okuma erişimi olan biri içeriği ekrandan çıkarabilir. Bu teknik olarak engellenemez; NDA/lisans sözleşmesi gerekir.
