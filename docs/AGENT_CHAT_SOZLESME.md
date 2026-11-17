# Portal ajan sohbeti: backend ve frontend sözleşmesi

Portal kullanıcısı girişte terminal yerine sohbet ekranını görür. Ajan, kullanıcının
Linux hesabıyla ve terminalle aynı sandbox içinde arka planda açılan `claude -p` sürecidir.

## WebSocket: `GET /papi/agent`

Kimlik, Origin ve `stage === 'ready'` denetimi `/papi/terminal` ile aynıdır. Kullanıcı başına tek konuşma vardır.
Tüm çerçeveler JSON metindir.

### Sunucudan istemciye

```ts
type ServerFrame =
  | { t: 'hello'; id: string | null; started: string | null; alive: boolean; busy: boolean;
      authRequired: boolean; events: ChatEvent[] }      // bağlanınca bir kez; geçmişin tamamı
  | { t: 'state'; id: string | null; started: string | null; alive: boolean; busy: boolean;
      authRequired: boolean }                           // durum her değiştiğinde
  | { t: 'ev'; ev: ChatEvent }                          // yeni olay ya da aynı id'li olayın güncel hali
  | { t: 'delta'; id: string; text: string }            // akan metin; id'li text olayına eklenir
  | { t: 'reset' };                                     // konuşma sıfırlandı, ekranı temizle
```

```ts
type DiffRow = { old: number | null; cur: number | null; type: 'add' | 'del' | 'ctx' | 'hunk'; text: string };
type ToolKind = 'read' | 'write' | 'edit' | 'exec' | 'search' | 'glob' | 'fetch' | 'web' | 'todo' | 'agent' | 'other';

type ChatEvent =
  | { kind: 'user'; id: string; ts: number; text: string }
  | { kind: 'text'; id: string; ts: number; text: string; done: boolean }
  | { kind: 'thinking'; id: string; ts: number; seconds: number | null }
  | { kind: 'tool'; id: string; ts: number; tool: ToolKind; name: string;
      path?: string; command?: string; pattern?: string; url?: string; description?: string;
      diff?: { file: string; add: number; del: number; rows: DiffRow[] };
      status: 'running' | 'completed' | 'failed';
      summary?: string;      // "120 satır okundu", "5 dosya bulundu"
      output?: string;       // yalnızca exec: en çok 3 satır, satır başına 160 karakter
      moreLines?: number;    // gösterilmeyen satır sayısı
      error?: string }       // en çok 300 karakter
  | { kind: 'permission'; id: string; ts: number; tool: ToolKind; name: string; description?: string;
      path?: string; command?: string; diff?: { file: string; add: number; del: number; rows: DiffRow[] };
      canAlways: boolean;
      status: 'pending' | 'allowed' | 'allowed_always' | 'denied' | 'expired' }
  | { kind: 'question'; id: string; ts: number;
      questions: { question: string; header?: string; multiSelect: boolean;
                   options: { label: string; description?: string }[] }[];
      status: 'pending' | 'answered' | 'expired' }
  | { kind: 'turn_end'; id: string; ts: number; outcome: 'ok' | 'error' | 'stopped'; message?: string }
  | { kind: 'notice'; id: string; ts: number; level: 'info' | 'warn' | 'error'; text: string };
```

### İstemciden sunucuya

```ts
type ClientFrame =
  | { t: 'send'; text: string }                      // en çok 100000 karakter
  | { t: 'perm'; id: string; allow: boolean; always?: boolean }
  | { t: 'answer'; id: string; answers: Record<string, string> }  // soru metni -> seçilen etiket(ler), çoklu seçimde ", " ile
  | { t: 'stop' }                                    // çalışan turu keser
  | { t: 'restart' }                                 // süreci yeniden başlatır, konuşma --resume ile sürer
  | { t: 'new' };                                    // konuşmayı siler, yeni süreç açar
```

Kapanış kodları `/papi/terminal` ile aynıdır: 4000 başka sekme devraldı, 1008 yetki yok, 1000 normal.

### Ek: model, efor, dosya eki, yeniden deneme durumu

`hello` ve `state` çerçevelerine şu alanlar eklenir:

```ts
model: string | null;      // seçili model değeri; null = varsayılan
effort: string | null;     // 'low' | 'medium' | 'high' | 'xhigh' | 'max'; null = varsayılan
retry: { attempt: number; max: number } | null;  // model bağlantısı yeniden deneniyor
maxEffort: string;         // yöneticinin bu kullanıcıya verdiği üst sınır; varsayılan 'xhigh'. Üstündeki seçenekler pasif görünür, sunucu da reddeder.
```

Yeni sunucu çerçevesi (süreç açılıp `initialize` yanıtı gelince):

```ts
{ t: 'models'; models: { value: string; label: string; description?: string; efforts: string[] }[] }
```

`user` olayına `attachments?: { name: string; kind: 'image' | 'pdf' | 'text'; size: number }[]` eklenir (içerik yok, yalnızca üst bilgi).

Yeni ve değişen istemci çerçeveleri:

```ts
| { t: 'send'; text: string; attachments?: { name: string; mime: string; data: string /* base64 */ }[] }
| { t: 'set_model'; model: string }     // yalnızca son `models` listesindeki değerler
| { t: 'set_effort'; effort: string }   // yalnızca seçili modelin `efforts` listesindeki değerler
```

`text` boş olabilir, yeter ki ek olsun. Ek sınırları: en çok 5 dosya; toplam en çok 20 MB. Resim `image/png|jpeg|webp|gif` en çok 5 MB,
PDF en çok 20 MB, metin ve kod dosyası en çok 1 MB (geçerli UTF-8, NUL baytı yok). Sınırı aşan ya da türü doğrulanamayan dosyada
mesaj gönderilmez, `notice` (error) döner. Dosya içeriği diske, kayda (cast) ve konuşma dosyasına yazılmaz; yalnızca ad, tür ve boyut yazılır.

### Ek: geçmiş sohbetler

`Yeni sohbet` eski konuşmayı silmez, arşive taşır (hiç mesajı olmayan sohbet saklanmaz).

```ts
// sunucudan: bağlanınca, yeni sohbette, sohbet değişince ve bir sohbetin ilk mesajında
{ t: 'chats'; chats: { id: string; title: string; updated: number; active: boolean }[] }  // en yeni önce, en çok 50
// istemciden: başka bir sohbete geçer; açık sohbet arşive gider, süreç --resume ile yeniden açılır
{ t: 'open_chat'; id: string }
```

Sohbet değişince sunucu yeni bir `hello` gönderir: istemci olay listesini bununla baştan kurar. Başlık kullanıcının ilk mesajından üretilir.

Silme: `{ t: 'delete_chat'; id: string }`. Sohbet kullanıcı listesinden kalkar ama yok edilmez, yönetici kayıtlarına taşınır ve denetim kaydına yazılır. Silinen sohbet açıksa ekran boş yeni sohbete geçer. Kullanıcıya gösterilen onay metni bu gerçeği söyler.

Admin: `GET /api/portal/deleted-chats` -> `{ username, id, title, deletedAt }[]` (yeniden eskiye). `GET /api/portal/deleted-chats/:username/:id` -> `{ events: ChatEvent[] }` (görüntüleme denetim kaydına yazılır).

## REST: `GET /papi/projects`

`[{ name: string; perm: 'r' | 'rw' }]`. Kullanıcıya açılmış projeler. Yetki denetimi `/papi/devlog` ile aynıdır.

## REST: `GET /papi/projects/:name/tree?path=<göreli yol>`

`{ entries: { name: string; type: 'dir' | 'file' | 'link'; size?: number }[]; truncated: boolean }`. Tek klasör düzeyi; klasörler önce, ada göre sıralı; en çok 500 kayıt; `.git` gösterilmez; sembolik bağ izlenmez. Hatalar: 400 geçersiz yol, 403 yetki yok, 404 okunamadı. Dosya içeriği yoktur ve yoktur da olmayacak.

## Admin: efor sınırı

`GET /api/portal/accounts` kayıtlarına `maxEffort` eklenir. `PUT /api/portal/accounts/:userId/max-effort { maxEffort }` sınırı değiştirir ve denetim kaydına yazılır. Yeni sınır, kullanıcının bir sonraki mesajında ya da bağlanışında geçerli olur.

## Güvenlik kuralları (bozulamaz)

1. **Tarayıcıya yalnızca bu sözleşmedeki alanlar gider.** Sunucu, Claude'un olaylarını iletmez; izin listesi
   mantığıyla sıfırdan yeni nesne kurar. Okunan dosya içeriği, arama sonuçları ve düşünce metni hiçbir alanda geçmez.
2. Araç özeti: Read yalnızca yol + satır sayısı. Grep ve Glob yalnızca desen + sayı. Bash komut (en çok 500 karakter)
   + en çok 3 satır çıktı. Write ve Edit yol + en çok 80 satır fark. Bu, terminalde görünenle aynı sınırdır.
   Bilinmeyen araçlarda ve MCP'de girdi iletilmez, yalnızca ad.
3. Oturum kaydına (cast) da yalnızca süzülmüş metin yazılır.
4. Sohbet ekranında kopyalama yoktur: terminaldeki gibi seçim ve kopyalama kapalıdır, kopyala düğmesi bulunmaz.
5. İzin yanıtında `updatedInput` istemciden alınmaz; sunucunun sakladığı özgün girdi kullanılır. "Bu oturumda hep izin ver"
   yalnızca Claude'un önerdiği `addRules`, `addDirectories` ve `acceptEdits` önerilerini `destination: 'session'` ile uygular.
