# Ekran kilidi: backend ve frontend sözleşmesi

Örnek: `/srv/gate/ornek/` (`KULLANIM.md`). Akış ve tuzaklar oradan alınır, kod kopyalanmaz. Gate'te oturum çerezi httpOnly'dir ve
sunucuda durur; bu yüzden örnekteki token emaneti gerekmez. Kilit, oturum kaydındaki bir alandır.

## Kararlar (yönetici onaylı)

- Portal ve admin panelinin ikisinde de vardır.
- Varsayılan süre 5 dk. Seçenekler `1, 2, 3, 5, 10, 15, 30, 60` dk. Kullanıcı üst sınırın altındakileri seçebilir. "Kapalı" yoktur.
- Üst sınırı yönetici belirler (tek genel ayar, varsayılan 15 dk). Sınır düşerse kullanıcının seçimi sınıra çekilir.
- Kilit açma: 4 haneli PIN. Sıralı (`1234`, `4321`) ve tek rakam tekrarlı PIN reddedilir. 5 hatada 10 dk kilit. Sayaç hesap başınadır ve sunucudadır.
- PIN hesap parolası doğrulanmadan belirlenemez ya da değiştirilemez. PIN'i olmayan hesap panele giremez, önce PIN belirler.
- PIN'i unutan kilit ekranından çıkış yapar, parola ve TOTP ile girer, ayarlardan yeni PIN belirler. Hesap sıfırlama PIN'i de siler.
- Kilit öncesi 30 sn geri sayım kartı: "Devam et" ve "Şimdi kilitle". Elle "Ekranı kilitle" düğmesi. Hareket sayacı sıfırlar.
- Zemin tamamen opaktır; alttaki sayfa görünmez (bulanıklık kullanılmaz).

## Veri (`core/db.ts` `migrate`)

- `portal_accounts` ve `admins`: `pin_hash TEXT`, `pin_failures INTEGER DEFAULT 0`, `pin_locked_until INTEGER`, `lock_minutes INTEGER`.
- `portal_sessions` ve `sessions`: `locked INTEGER DEFAULT 0`, `last_active INTEGER`.
- `settings`: `lock.maxMinutes` (varsayılan 15).
- PIN özeti mevcut `hashPassword`/`verifyPassword` ile. PIN hiçbir yere (log, audit, yanıt) yazılmaz.

## Sunucu kuralları (bozulamaz)

1. **Kilitli oturum her korumalı uçta reddedilir.** Portal'da `Stage` listesine `setup_pin` ve `locked` eklenir: `change_password` > `setup_totp` > `setup_pin` > `locked`/`ready`. Mevcut `stage !== 'ready'` denetimleri bu sayede `/papi/*`, `/papi/terminal`, `/papi/agent` ve kare başına denetimleri korur. `/papi/password` ve `/papi/totp/*` kilitliyken çalışmaz. Kilitli oturumda yalnızca şunlar çalışır: `GET /papi/status`, `GET /papi/meta`, `POST /papi/lock/unlock`, `POST /papi/logout`, `POST /papi/login`.
2. **Admin:** `/api/*` korumalı uçlar, kilitli oturumda 423 `{error:'locked'}`, PIN yokken 428 `{error:'setup_pin'}` döner. Admin WS uçları (`/api/terminal`, `/api/sessions/:id/watch`) reddeder. Serbest kalanlar: durum ucu, `/api/auth/lock/unlock`, çıkış, giriş. `/api/auth/totp/*` kilitliyken çalışmaz.
3. **Kilitlenince o oturumun açık soketleri sunucudan kapatılır**, kod `4001`, neden `locked`. Yalnızca o oturumun soketi kapanır (aynı kullanıcının başka oturumu etkilenmez; soket hangi oturum çerezine aitse ona göre eşlenir, token loglanmaz). Portal terminali ve ajan süreci ölmez, mevcut `detach` süresi işler; kilit açılınca istemci yeniden bağlanır. Ajan arkada çalışmayı sürdürür. Admin terminali mevcut davranışıyla (WS kapanınca süreç biter) kapanır. Canlı izleme soketi de kapanır.
4. **Sunucu tarafı yedek kilit:** `last_active`, istemcinin `POST .../lock/activity` çağrılarıyla ve PIN/kilit açma ile güncellenir; `status` yoklaması, terminal ve ajan çıktısı etkin sayılmaz. Oturum doğrulanırken `now - last_active > (etkin süre + 60 sn)` ise oturum kilitlenir ve soketler kapatılır. Terminal ve sohbet soketinden gelen kullanıcı girdisi de etkinlik sayılır (yazma sıklığı 30 sn ile sınırlı). Tarayıcı kapalıyken ya da bilgisayar uykudayken süre dolarsa açılışta kilit görünür.
5. PIN doğrulaması sunucuda; ayrı "doğrula" ucu yok. Yanlış PIN sayacı atomik artar, 5. hatada `pin_locked_until = now+10dk`, sayaç sıfırlanır. Başarıda sayaç sıfırlanır. Kilit açma istekleri mevcut giriş hız sınırlamasına da tabidir (IP + hesap).
6. Audit: `*.lock` (neden: `bosta|elle|sunucu`), `*.unlock`, `*.unlock_failed` (PIN'siz), `*.pin_set`, `*.lock_minutes`, `lock.max_minutes`.
7. Hesap sıfırlama (`POST /api/portal/accounts/:userId`) PIN, sayaç ve `lock_minutes` alanlarını temizler; yeni oturum `setup_pin`'den geçer.

## Uçlar

Portal (`/papi`), Admin (`/api/auth`) aynı biçim:

| Yöntem ve yol | Girdi | Başarı | Hata |
|---|---|---|---|
| `POST /pin` (`/papi/pin`, `/api/auth/pin`) | `{password, pin}` | `{ok:true}` | 400 `pin_weak`, 403 `invalid_current_password` |
| `POST /lock/now` | `{reason:'bosta'\|'elle'}` | `{locked:true}` | 401 |
| `POST /lock/unlock` | `{pin}` | `{ok:true}` | 403 `{error:'pin_invalid', remaining}`, 423 `{error:'pin_locked', seconds}`, 400 biçim |
| `POST /lock/activity` | yok | `{ok:true, idleSeconds}` (etkin süreye göre kalan) | 401, kilitliyse `{ok:false, locked:true}` |
| `PUT /lock/minutes` | `{minutes}` | `{minutes}` | 400 listede yok ya da sınırı aşıyor |

Durum yanıtına eklenir (`GET /papi/status`, admin durum ucu):

```ts
stage: '...' | 'setup_pin' | 'locked';   // admin: `locked: boolean`, `pinRequired: boolean`
lock: { minutes: number; maxMinutes: number; options: number[]; warningSeconds: 30 };
```

Yönetici sınırı: `GET /api/lock/settings` -> `{maxMinutes, options}`, `PUT /api/lock/settings {maxMinutes}` (izinli: seçeneklerden biri). Kilit sınırı düşünce etkin süre sınırla kısılır.

## İstemci kuralları

- Süre **zaman damgasıyla** ölçülür (uykudan uyanınca fark geçmişse hemen kilit). `visibilitychange` ve `focus` aynı denetimi yapar.
- Sekmeler tek sayaç paylaşır (`localStorage` + `storage` olayı): biri kilitlenince hepsi, biri açınca hepsi. Sunucudan `423` ya da `stage:'locked'` ya da soket `4001` gelirse anında kilit ekranı.
- Hareket: `pointerdown`, `pointermove`, `keydown`, `wheel`, `touchstart`, en çok 1 sn'de bir işlenir; sunucuya en çok 30 sn'de bir `lock/activity`.
- Kilit ekranı açıkken uygulama ağacı mount kalır ama `display:none` + `inert` ile gizlenir (taslak, açık form, xterm içeriği korunur). Kilit açılınca sohbet ve terminal yeniden bağlanır; soket `4001`'de otomatik yeniden bağlanmaz, kilit açılınca bağlanır.
- `setup_pin` aşamasında PIN belirleme ekranı (`AuthShell` görsel diliyle): hesap parolası + PIN + tekrar.
