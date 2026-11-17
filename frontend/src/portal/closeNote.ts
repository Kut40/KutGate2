export function closeNoteFor(reason: string): string {
  switch (reason) {
    case 'locked':
      return 'Ekran kilitli.';
    case 'replaced':
      return 'Başka bir sekmede açıldı.';
    case 'max_concurrent':
      return 'Açık oturum sınırına ulaşıldı. Başka bir oturumu kapatıp yeniden bağlanın.';
    case 'unauthorized':
      return 'Oturum izni yok.';
    case 'admin':
      return 'Oturum yönetici tarafından sonlandırıldı.';
    case 'logout':
      return 'Çıkış yapıldı.';
    case 'detached_timeout':
      return 'Bağlantı uzun süre koptuğu için oturum kapandı.';
    case 'idle':
      return 'Oturum boşta kaldığı için kapandı.';
    case 'max':
      return 'Oturum süresi doldu.';
    case 'closed':
      return 'Oturum kapatıldı.';
    case 'exit':
    case 'ended':
      return 'Oturum sona erdi.';
    case 'error':
      return 'Oturum bir hata nedeniyle kapandı.';
    case 'invalid':
      return 'Oturum başlatılamadı.';
    default:
      return 'Bağlantı kapandı.';
  }
}
