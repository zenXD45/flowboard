import { useEffect, useRef, useState } from 'react';
import { api, ownPath } from '../lib/api.js';
import { API_BASE } from '../lib/config.js';
import { useAuth } from '../context/AuthContext.jsx';
import { storeTheme, THEMES } from '../lib/theme.js';
import Avatar, { AVATAR_COLORS } from '../components/Avatar.jsx';
import Icon from '../components/Icon.jsx';

const THEME_LABELS = { system: 'System', dark: 'Dark', light: 'Light' };

/**
 * Shrink a chosen file to a square-ish 128px PNG in the browser.
 *
 * The server caps the upload at 256 KB, and a phone photo is several megabytes,
 * so resizing here is what makes a normal photo acceptable at all. PNG is kept
 * rather than JPEG because the result is tiny at this size and it preserves the
 * transparency a logo or stitched image might have.
 */
function resizeImage(file, max = 128) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('That file is not an image'));
      image.onload = () => {
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png'));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function Section({ title, hint, children }) {
  return (
    <section className="settings__section">
      <div className="settings__sectionhead">
        <h2>{title}</h2>
        {hint && <p className="muted">{hint}</p>}
      </div>
      <div className="settings__card">{children}</div>
    </section>
  );
}

export default function Settings({ onExit }) {
  const { user, updateUser, logout } = useAuth();
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [profile, setProfile] = useState({ displayName: '', username: '', email: '' });
  const [avatarUrl, setAvatarUrl] = useState('');
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' });
  const [connections, setConnections] = useState([]);
  const [danger, setDanger] = useState({ confirm: '', password: '' });
  const fileRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    setProfile({
      displayName: user.displayName || '',
      username: user.username || '',
      email: user.email || ''
    });
    setAvatarUrl(user.avatar && /^https:/i.test(user.avatar) ? user.avatar : '');
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    api
      .connections()
      .then((data) => {
        if (!cancelled) setConnections(data.connections);
      })
      .catch(() => {
        if (!cancelled) setNotice({ tone: 'error', message: 'Could not load connected accounts.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // A fresh id per notice so the element remounts when the message changes —
  // otherwise React keeps the same <p> and the entrance never replays, which
  // means a second save in a row shows no feedback at all.
  const noticeSeq = useRef(0);
  const note = (message, tone = 'info') => setNotice({ id: ++noticeSeq.current, message, tone });

  const saveProfile = async (e) => {
    e.preventDefault();
    setBusy('profile');
    try {
      const data = await api.updateProfile(profile);
      updateUser(data.user);
      note('Profile saved.');
    } catch (err) {
      note(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const pickColor = async (index) => {
    try {
      const data = await api.updateProfile({ avatarColor: String(index) });
      updateUser(data.user);
    } catch (err) {
      note(err.message, 'error');
    }
  };

  const applyAvatarUrl = async (e) => {
    e.preventDefault();
    try {
      const data = await api.updateProfile({ avatar: avatarUrl.trim() });
      updateUser(data.user);
      note('Avatar updated.');
    } catch (err) {
      note(err.message, 'error');
    }
  };

  const removeAvatar = async () => {
    try {
      const data = await api.updateProfile({ avatar: '' });
      updateUser(data.user);
      setAvatarUrl('');
      note('Avatar removed.');
    } catch (err) {
      note(err.message, 'error');
    }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('avatar');
    try {
      const image = await resizeImage(file);
      const data = await api.uploadAvatar(image);
      updateUser(data.user);
      note('Avatar updated.');
    } catch (err) {
      note(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const chooseTheme = async (preference) => {
    const previous = user?.theme || 'system';
    // Applied immediately: waiting for the round trip would make the selection
    // feel laggy, and theme is trivially reversible if the save fails.
    storeTheme(preference);
    try {
      const data = await api.updateProfile({ theme: preference });
      updateUser(data.user);
    } catch (err) {
      storeTheme(previous);
      note(err.message, 'error');
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    if (password.next !== password.confirm) return note('The new passwords do not match.', 'error');
    setBusy('password');
    try {
      const data = await api.changePassword({
        currentPassword: password.current,
        newPassword: password.next
      });
      updateUser(data.user);
      setPassword({ current: '', next: '', confirm: '' });
      note('Password updated.');
    } catch (err) {
      note(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const connect = async (provider) => {
    try {
      const data = await api.linkProvider(provider);
      // The server builds this path; we still confirm it is one of ours before
      // handing it to the browser. `API_BASE` is empty in production, so a
      // response body is otherwise the whole navigation target.
      const path = ownPath(data?.url);
      if (!path) {
        note('The sign-in link could not be read. Try again.', 'error');
        return;
      }
      window.location.href = `${API_BASE}${path}`;
    } catch (err) {
      note(err.message, 'error');
    }
  };

  const disconnect = async (provider) => {
    try {
      await api.unlinkProvider(provider);
      setConnections((rows) => rows.map((r) => (r.id === provider ? { ...r, connected: false } : r)));
      note('Account disconnected.');
    } catch (err) {
      note(err.message, 'error');
    }
  };

  const deleteAccount = async (e) => {
    e.preventDefault();
    setBusy('delete');
    try {
      await api.deleteAccount({ confirm: danger.confirm, password: danger.password });
      logout();
      window.location.hash = '';
    } catch (err) {
      note(err.message, 'error');
      setBusy('');
    }
  };

  const hasPassword = Boolean(user?.hasPassword);

  return (
    <div className="settings">
      <header className="settings__top">
        <button type="button" className="ghostbtn" onClick={onExit}>
          <Icon name="back" size={14} /> Back to boards
        </button>
        <h1>Account settings</h1>
        <p className="muted">Signed in as @{user?.username}</p>
      </header>

      {notice && (
        <p key={notice.id} className={`settings__notice settings__notice--${notice.tone}`} role="status">
          {notice.message}
        </p>
      )}

      <Section title="Profile" hint="How you appear on boards and in activity.">
        <div className="settings__avatar">
          <Avatar
            userId={user?.id}
            username={user?.username}
            displayName={user?.displayName}
            avatar={user?.avatar}
            avatarColor={user?.avatarColor}
            size={72}
          />
          <div className="settings__avataractions">
            <div className="settings__row">
              <button type="button" className="btn" disabled={busy === 'avatar'} onClick={() => fileRef.current?.click()}>
                {busy === 'avatar' ? 'Uploading…' : 'Upload image'}
              </button>
              <button type="button" className="ghostbtn" onClick={removeAvatar}>
                Remove
              </button>
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} />
            <p className="muted settings__tiny">Resized to 128×128 before upload. PNG, JPEG or WebP.</p>
          </div>
        </div>

        <div className="settings__swatches" role="group" aria-label="Avatar colour">
          {Array.from({ length: AVATAR_COLORS }, (_, index) => (
            <button
              key={index}
              type="button"
              className={`swatch${String(index) === user?.avatarColor ? ' swatch--on' : ''}`}
              aria-label={`Colour ${index + 1}`}
              aria-pressed={String(index) === user?.avatarColor}
              onClick={() => pickColor(index)}
            />
          ))}
        </div>

        <form className="settings__avatarurl" onSubmit={applyAvatarUrl}>
          <label className="vh" htmlFor="avatar-url">
            Avatar image URL
          </label>
          <input
            id="avatar-url"
            value={avatarUrl}
            placeholder="https://example.com/avatar.png"
            onChange={(e) => setAvatarUrl(e.target.value)}
          />
          <button type="submit" className="ghostbtn">
            Use URL
          </button>
        </form>

        <form className="settings__form" onSubmit={saveProfile}>
          <label>
            Display name
            <input
              value={profile.displayName}
              maxLength={40}
              placeholder="Your name"
              onChange={(e) => setProfile({ ...profile, displayName: e.target.value })}
            />
          </label>
          <label>
            Username
            <input
              value={profile.username}
              maxLength={24}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setProfile({ ...profile, username: e.target.value })}
            />
          </label>
          <label>
            Email
            <input
              value={profile.email}
              type="email"
              placeholder="you@example.com"
              onChange={(e) => setProfile({ ...profile, email: e.target.value })}
            />
            {profile.email && !user?.emailVerified && (
              <span className="settings__tiny muted">Not verified — we never treat a typed address as confirmed.</span>
            )}
          </label>
          <div className="settings__actions">
            <button type="submit" className="btn" disabled={busy === 'profile'}>
              Save profile
            </button>
          </div>
        </form>
      </Section>

      <Section title="Appearance" hint="Applies to this device immediately.">
        <div className="segmented" role="group" aria-label="Theme">
          {THEMES.map((preference) => (
            <button
              key={preference}
              type="button"
              className={`segmented__option${(user?.theme || 'system') === preference ? ' segmented__option--on' : ''}`}
              aria-pressed={(user?.theme || 'system') === preference}
              onClick={() => chooseTheme(preference)}
            >
              {THEME_LABELS[preference]}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="Password"
        hint={hasPassword ? 'Used to sign in with your username.' : 'Set a password so you are not dependent on a provider.'}
      >
        <form className="settings__form" onSubmit={savePassword}>
          <label>
            {user?.hasPassword ? 'Current password' : 'Current password (none set)'}
            <input
              type="password"
              value={password.current}
              autoComplete="current-password"
              onChange={(e) => setPassword({ ...password, current: e.target.value })}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              value={password.next}
              autoComplete="new-password"
              onChange={(e) => setPassword({ ...password, next: e.target.value })}
            />
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              value={password.confirm}
              autoComplete="new-password"
              onChange={(e) => setPassword({ ...password, confirm: e.target.value })}
            />
          </label>
          <div className="settings__actions">
            <button type="submit" className="btn" disabled={busy === 'password'}>
              Update password
            </button>
          </div>
        </form>
      </Section>

      <Section title="Connected accounts" hint="Sign in with a provider, or remove one.">
        <ul className="settings__connections">
          {connections.map((row) => (
            <li key={row.id} className="settings__connection">
              <span className="settings__connectionname">
                {row.label}
                {row.connected && <span className="pill pill--ok">Connected</span>}
              </span>
              {row.connected ? (
                <button type="button" className="ghostbtn" onClick={() => disconnect(row.id)}>
                  Disconnect
                </button>
              ) : row.available ? (
                <button type="button" className="ghostbtn" onClick={() => connect(row.id)}>
                  <Icon name="link" size={14} /> Connect
                </button>
              ) : (
                <span className="muted settings__tiny">Not configured</span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Delete account" hint="This cannot be undone.">
        <p className="settings__dangertext">
          Deleting your account permanently removes the boards you own together with their cards, comments and
          activity. On boards you are only a member of, your membership is removed and any cards assigned to you are
          unassigned.
        </p>
        <form className="settings__form" onSubmit={deleteAccount}>
          <label>
            Type your username to confirm
            <input
              value={danger.confirm}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={user?.username}
              onChange={(e) => setDanger({ ...danger, confirm: e.target.value })}
            />
          </label>
          {user?.hasPassword && (
            <label>
              Password
              <input
                type="password"
                value={danger.password}
                autoComplete="current-password"
                onChange={(e) => setDanger({ ...danger, password: e.target.value })}
              />
            </label>
          )}
          <div className="settings__actions">
            <button
              type="submit"
              className="btn btn--danger"
              disabled={busy === 'delete' || danger.confirm !== user?.username}
            >
              <Icon name="trash" size={14} /> Delete my account
            </button>
          </div>
        </form>
      </Section>
    </div>
  );
}
