import { useState } from 'react';
import defaultAvatar from '../team-photos/default-avatar.svg';
import { fileToAvatar } from '../../core/avatarImage';
import { Button, useToast } from '../../core/ui';
import { errMsg, papi } from '../api';

export function PhotoPanel({ avatar, onChange }: { avatar: string | null; onChange: (url: string | null) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const image = await fileToAvatar(file);
      const r = await papi<{ avatar: string | null }>('PUT', '/me/avatar', { image });
      onChange(r.avatar);
      toast.success('Fotoğrafınız güncellendi.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await papi('DELETE', '/me/avatar');
      onChange(null);
      toast.success('Fotoğrafınız kaldırıldı.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="avatar-edit">
      {avatar ? <img className="avatar-edit-img" src={avatar} alt="Fotoğrafınız" /> : <img className="avatar-edit-img" src={defaultAvatar} alt="Ortak profil resmi" />}
      <div className="avatar-edit-acts">
        <label className="btn btn-primary btn-sm">
          {avatar ? 'Fotoğrafı değiştir' : 'Fotoğraf yükle'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-file"
            disabled={busy}
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        {avatar ? (
          <Button small onClick={() => void remove()} disabled={busy}>
            Kaldır
          </Button>
        ) : null}
        <span className="hint">Takım sayfasındaki kartınızda görünür. 3:4 oranında otomatik kırpılır.</span>
      </div>
    </div>
  );
}
