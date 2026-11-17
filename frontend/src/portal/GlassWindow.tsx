import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  errMsg,
  getStatus,
  papi,
  PortalError,
  type Stage,
} from "./api";
import { ForgotForm } from "./ForgotForm";
import "./glass-window.css";

export type GlassWindowHandle = { open: (opener?: HTMLElement | null) => void };

const OTP_LENGTH = 6;

type StepState = "run" | "ok" | "err";
type Step = { text: string; state: StepState };

const STAGE_TEXT: Partial<Record<Stage, string>> = {
  change_password: "Parola değişikliği gerekli",
  setup_totp: "İki adımlı doğrulama kurulumu gerekli",
  setup_pin: "PIN kurulumu gerekli",
  locked: "Ekran kilidi açılmalı",
};

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export const GlassWindow = forwardRef<
  GlassWindowHandle,
  { onOpenChange?: (open: boolean) => void }
>(function GlassWindow({ onOpenChange }, ref) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const ids = useId();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [otp, setOtp] = useState("");
  const [otpFocused, setOtpFocused] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [ip, setIp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [forgotBusy, setForgotBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState("");
  const [errorTitle, setErrorTitle] = useState("");
  const [credBad, setCredBad] = useState(false);
  const [userInvalid, setUserInvalid] = useState(false);
  const [pwInvalid, setPwInvalid] = useState(false);

  const locked = busy || ok;
  const code = otp;
  const alertId = `${ids}-alert`;
  const lastStep = steps.length ? steps[steps.length - 1] : null;

  useImperativeHandle(ref, () => ({
    open(opener) {
      openerRef.current = opener ?? null;
      setError("");
      setErrorTitle("");
      dialogRef.current?.showModal();
      (username.trim() ? pwRef.current : userRef.current)?.focus();
      onOpenChange?.(true);
      if (!ip) {
        papi<{ ip?: string }>("GET", "/meta")
          .then((m) => setIp(typeof m?.ip === "string" ? m.ip : ""))
          .catch(() => undefined);
      }
    },
  }));

  useEffect(() => {
    if (needTotp) otpRef.current?.focus();
  }, [needTotp]);

  const close = () => {
    if (!locked && !forgotBusy) dialogRef.current?.close();
  };

  const onClosed = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPassword("");
    setShowPw(false);
    setOtp("");
    setNeedTotp(false);
    setForgot(false);
    setForgotBusy(false);
    setNotice("");
    setSteps([]);
    setError("");
    setErrorTitle("");
    setBusy(false);
    setOk(false);
    setUserInvalid(false);
    setPwInvalid(false);
    setCredBad(false);
    onOpenChange?.(false);
    openerRef.current?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (locked) return;
    if (!needTotp) {
      const uBad = !username.trim();
      const pBad = !password;
      setUserInvalid(uBad);
      setPwInvalid(pBad);
      if (uBad || pBad) {
        setError("");
        (uBad ? userRef.current : pwRef.current)?.focus();
        return;
      }
    } else if (!/^\d{6}$/.test(code)) {
      setErrorTitle("");
      setError("6 haneli doğrulama kodunu girin.");
      otpRef.current?.focus();
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const { signal } = ctrl;
    const alive = () => !signal.aborted;
    const push = (text: string) =>
      setSteps((prev) => [...prev, { text, state: "run" }]);
    const settle = (state: StepState, text?: string) =>
      setSteps((prev) =>
        prev.map((st, i) =>
          i === prev.length - 1 ? { ...st, state, text: text ?? st.text } : st,
        ),
      );
    const fail = (title: string, text: string) => {
      setErrorTitle(title);
      setError(text);
    };
    const timed = <T,>(p: Promise<T>, ms: number) =>
      Promise.all([
        p.then(
          (v) => ({ v, e: null as unknown }),
          (e: unknown) => ({ v: null as T | null, e }),
        ),
        wait(ms, signal),
      ]).then(([r]) => r);

    setError("");
    setErrorTitle("");
    setNotice("");
    setBusy(true);
    try {
      setSteps([{ text: "Sunucuya bağlanılıyor", state: "run" }]);
      const meta = await timed(
        papi<{ ip?: string }>("GET", "/meta", undefined, signal),
        900,
      );
      if (!alive()) return;
      if (meta.e) {
        settle("err", "Sunucuya bağlanılamadı");
        fail(
          "Bağlantı kurulamadı",
          "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
        );
        return;
      }
      if (typeof meta.v?.ip === "string") setIp(meta.v.ip);
      settle("ok");

      push(
        needTotp
          ? "Doğrulama kodu kontrol ediliyor"
          : "Kimlik bilgileri doğrulanıyor",
      );
      const body: { username: string; password: string; totp?: string } = {
        username: username.trim(),
        password,
      };
      if (needTotp) body.totp = code;
      const login = await timed(
        papi<{ ok: boolean; stage?: string; redirect?: string }>(
          "POST",
          "/login",
          body,
          signal,
        ),
        1500,
      );
      if (!alive()) return;
      const err = login.e;
      if (err) {
        const errCode = err instanceof PortalError ? err.code : "";
        if (errCode === "totp_required") {
          settle("ok");
          push("Oturum açılıyor");
          await wait(1000, signal);
          if (!alive()) return;
          settle("ok");
          push("TOTP ekranına yönlendiriliyor");
          await wait(1000, signal);
          if (!alive()) return;
          settle("ok");
          await wait(350, signal);
          if (!alive()) return;
          setSteps([]);
          setNeedTotp(true);
          return;
        }
        if (errCode === "admin_totp_setup_required") {
          settle("err", "Kimlik bilgileri doğrulanamadı");
          fail(
            "Yönetici doğrulaması eksik",
            "Yönetici girişi için önce yerel yönetim panelinden iki adımlı doğrulamayı etkinleştirin.",
          );
        } else if (errCode === "invalid_credentials") {
          settle("err", "Kimlik bilgileri doğrulanamadı");
          fail(
            "Giriş başarısız",
            "Kullanıcı adı ya da parola hatalı. Bilgilerinizi kontrol edip tekrar deneyin.",
          );
          flushSync(() => {
            setNeedTotp(false);
            setOtp("");
            setCredBad(true);
            setPassword("");
          });
          pwRef.current?.focus();
        } else if (needTotp && errCode === "invalid_totp") {
          settle("err", "Doğrulama kodu kabul edilmedi");
          fail(
            "Kod doğrulanamadı",
            "Girdiğiniz kod hatalı ya da süresi dolmuş. Uygulamadaki güncel kodu girin.",
          );
          setOtp("");
          otpRef.current?.focus();
        } else {
          settle(
            "err",
            needTotp
              ? "Doğrulama kodu kabul edilmedi"
              : "Kimlik bilgileri doğrulanamadı",
          );
          fail("Giriş yapılamadı", errMsg(err));
          if (needTotp) {
            setOtp("");
            otpRef.current?.focus();
          }
        }
        return;
      }
      settle("ok");
      const res = login.v;

      if (res && res.stage === "admin" && res.redirect) {
        push("Yönetici paneline yönlendiriliyor");
        await wait(1000, signal);
        if (!alive()) return;
        settle("ok");
        setOk(true);
        await wait(800, signal);
        if (!alive()) return;
        window.location.assign(res.redirect);
        return;
      }

      push("Oturum açılıyor");
      const status = await timed(
        getStatus(signal),
        1000,
      );
      if (!alive()) return;
      if (status.e || !status.v?.loggedIn) {
        settle("err", "Oturum açılamadı");
        fail(
          "Oturum açılamadı",
          "Giriş onaylandı ancak oturum başlatılamadı. Lütfen tekrar deneyin.",
        );
        return;
      }
      settle("ok");
      const pending = status.v.stage ? STAGE_TEXT[status.v.stage] : undefined;
      if (pending) {
        push(pending);
        await wait(900, signal);
        if (!alive()) return;
        settle("ok");
      }
      setOk(true);
      await wait(800, signal);
      if (!alive()) return;
      window.location.assign("/");
    } finally {
      if (alive()) {
        setBusy(false);
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    }
  };

  const describe = (...parts: (string | false | undefined)[]) =>
    parts.filter(Boolean).join(" ") || undefined;

  return (
    <dialog
      ref={dialogRef}
      className="kg-glass"
      aria-labelledby={forgot ? undefined : `${ids}-title`}
      aria-label={forgot ? "Parolayı sıfırla" : undefined}
      onClose={onClosed}
      onCancel={(e) => {
        if (locked || forgotBusy) e.preventDefault();
      }}
      onMouseDown={(e) => {
        if (e.target === dialogRef.current) close();
      }}
    >
      <button
        type="button"
        className="kg-glass-close"
        onClick={close}
        disabled={locked || forgotBusy}
        aria-label="Kapat"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      <div className="kg-glass-body">
        {forgot ? (
          <ForgotForm
            initialUser={username}
            onBusy={setForgotBusy}
            onBack={() => {
              setForgot(false);
              setError("");
              setErrorTitle("");
            }}
            onDone={(u) => {
              flushSync(() => {
                setForgot(false);
                setUsername(u);
                setPassword("");
                setCredBad(false);
                setError("");
                setErrorTitle("");
                setSteps([]);
                setNotice(
                  "Parolanız değiştirildi. Yeni parolanızla giriş yapın.",
                );
              });
              pwRef.current?.focus();
            }}
          />
        ) : (
          <form className="kg-f-form" onSubmit={submit} noValidate>
            <div className="kg-f-head">
              <h2 className="kg-f-title" id={`${ids}-title`}>
                Giriş yap
              </h2>
              <p className="kg-f-sub">KutGate Takım Çalışma Paneli</p>
            </div>

            {!needTotp ? (
              <>
                <div className="kg-f-field">
                  <label className="kg-f-label" htmlFor={`${ids}-user`}>
                    Kullanıcı adı
                  </label>
                  <input
                    ref={userRef}
                    id={`${ids}-user`}
                    className="kg-f-input"
                    type="text"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setCredBad(false);
                      if (userInvalid) setUserInvalid(false);
                    }}
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    readOnly={locked}
                    aria-invalid={userInvalid || credBad || undefined}
                    aria-describedby={describe(
                      userInvalid && `${ids}-user-err`,
                      credBad && !!error && alertId,
                    )}
                  />
                  {userInvalid ? (
                    <p className="kg-f-error" id={`${ids}-user-err`}>
                      Kullanıcı adınızı girin.
                    </p>
                  ) : null}
                </div>

                <div className="kg-f-field">
                  <label className="kg-f-label" htmlFor={`${ids}-pw`}>
                    Parola
                  </label>
                  <div className="kg-f-pw">
                    <input
                      ref={pwRef}
                      id={`${ids}-pw`}
                      className="kg-f-input"
                      type={showPw ? "text" : "password"}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setCredBad(false);
                        if (pwInvalid) setPwInvalid(false);
                      }}
                      autoComplete="current-password"
                      autoCapitalize="none"
                      spellCheck={false}
                      readOnly={locked}
                      aria-invalid={pwInvalid || credBad || undefined}
                      aria-describedby={describe(
                        pwInvalid && `${ids}-pw-err`,
                        credBad && !!error && alertId,
                      )}
                    />
                    <button
                      type="button"
                      className="kg-f-toggle"
                      onClick={() => setShowPw((v) => !v)}
                      aria-pressed={showPw}
                      aria-label={showPw ? "Parolayı gizle" : "Parolayı göster"}
                    >
                      {showPw ? "Gizle" : "Göster"}
                    </button>
                  </div>
                  {pwInvalid ? (
                    <p className="kg-f-error" id={`${ids}-pw-err`}>
                      Parolanızı girin.
                    </p>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="kg-f-field kg-f-field--center">
                <label
                  className="kg-f-label"
                  id={`${ids}-otp-label`}
                  htmlFor={`${ids}-otp`}
                >
                  Doğrulama kodu
                </label>
                <div className="kg-f-otp">
                  <input
                    ref={otpRef}
                    id={`${ids}-otp`}
                    className="kg-f-otp-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={OTP_LENGTH}
                    value={otp}
                    onChange={(e) => {
                      setOtp(
                        e.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH),
                      );
                      if (error) setError("");
                    }}
                    onFocus={(e) => {
                      setOtpFocused(true);
                      const len = e.target.value.length;
                      e.target.setSelectionRange(len, len);
                    }}
                    onBlur={() => setOtpFocused(false)}
                    readOnly={locked}
                    aria-labelledby={`${ids}-otp-label`}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? alertId : `${ids}-otp-desc`}
                  />
                  {Array.from({ length: OTP_LENGTH }, (_, i) => (
                    <span
                      key={i}
                      className={[
                        "kg-f-otp-slot",
                        otpFocused && i === Math.min(otp.length, OTP_LENGTH - 1)
                          ? "is-active"
                          : "",
                        error ? "is-invalid" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-hidden="true"
                    >
                      {otp[i] ?? ""}
                    </span>
                  ))}
                </div>
                {!error ? (
                  <p className="kg-f-desc" id={`${ids}-otp-desc`}>
                    Kimlik doğrulayıcı uygulamanızdaki 6 haneli kodu girin.
                  </p>
                ) : null}
              </div>
            )}

            {steps.length > 0 ? (
              <ul className="kg-f-steps" aria-hidden="true">
                {steps.map((st, i) => (
                  <li key={i} className={`kg-f-step kg-f-step--${st.state}`}>
                    <span className="kg-f-step-icon">
                      {st.state === "run" ? (
                        <span className="kg-f-step-spin" />
                      ) : st.state === "ok" ? (
                        "✓"
                      ) : (
                        "✗"
                      )}
                    </span>
                    <span>
                      {st.text}
                      {st.state === "run" ? "…" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="kg-f-sr" role="status" aria-live="polite">
              {ok
                ? "Giriş başarılı, yönlendiriliyorsunuz."
                : lastStep && lastStep.state !== "err"
                  ? lastStep.text
                  : ""}
            </p>

            {error && errorTitle ? (
              <div className="kg-f-alert" role="alert" id={alertId}>
                <svg
                  className="kg-f-alert-icon"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7.5v5.25M12 16.25v.01" />
                </svg>
                <div className="kg-f-alert-body">
                  <p className="kg-f-alert-title">{errorTitle}</p>
                  <p className="kg-f-alert-text">{error}</p>
                </div>
              </div>
            ) : error ? (
              <p
                className={
                  needTotp ? "kg-f-error kg-f-error--center" : "kg-f-error"
                }
                role="alert"
                id={alertId}
              >
                {error}
              </p>
            ) : null}

            {notice && !error ? (
              <p className="kg-f-notice" role="status">
                {notice}
              </p>
            ) : null}

            {ok ? (
              <p className="kg-f-ok" aria-hidden="true">
                Giriş başarılı, yönlendiriliyorsunuz.
              </p>
            ) : null}

            <button
              type="submit"
              className="kg-f-submit"
              disabled={locked}
              aria-busy={busy}
            >
              {busy ? <span className="kg-f-spin" aria-hidden="true" /> : null}
              {busy ? "Kontrol ediliyor" : needTotp ? "Doğrula" : "Giriş yap"}
            </button>

            {needTotp ? (
              <button
                type="button"
                className="kg-f-link"
                onClick={() => {
                  setNeedTotp(false);
                  setOtp("");
                  setSteps([]);
                  setError("");
                  setErrorTitle("");
                }}
                disabled={locked}
              >
                Geri dön
              </button>
            ) : (
              <button
                type="button"
                className="kg-f-link"
                onClick={() => {
                  setForgot(true);
                  setError("");
                  setErrorTitle("");
                  setNotice("");
                  setSteps([]);
                  setCredBad(false);
                }}
                disabled={locked}
              >
                Parolamı unuttum
              </button>
            )}
          </form>
        )}
        <p className="kg-f-foot">
          Bu oturum kaydedilmektedir · Yetkisiz erişim yasaktır
        </p>
        {ip ? <p className="kg-f-ip">Bağlantı IP adresiniz: {ip}</p> : null}
      </div>
    </dialog>
  );
});
