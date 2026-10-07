// Inline icons (stroke = currentColor) so they follow the theme.
type P = { size?: number };
const S = ({ size = 20, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconMarkets = (p: P) => (
  <S {...p}>
    <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
  </S>
);
export const IconWallet = (p: P) => (
  <S {...p}>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <path d="M3 10h18M16 14.5h2" />
  </S>
);
export const IconHistory = (p: P) => (
  <S {...p}>
    <path d="M12 7v5l3 2" />
    <circle cx="12" cy="12" r="9" />
  </S>
);
export const IconInfo = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </S>
);
export const IconSun = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </S>
);
export const IconMoon = (p: P) => (
  <S {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
  </S>
);
export const IconExternal = (p: P) => (
  <S {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </S>
);
export const IconCheck = (p: P) => (
  <S {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </S>
);
export const IconX = (p: P) => (
  <S {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </S>
);
export const IconThermo = (p: P) => (
  <S {...p}>
    <path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z" />
    <path d="M12 11v6" />
  </S>
);
export const IconDrop = (p: P) => (
  <S {...p}>
    <path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z" />
  </S>
);
export const Logo = ({ size = 26 }: P) => (
  <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
    <rect width="512" height="512" rx="112" fill="var(--logo-bg)" />
    <path d="M96 352 C176 352 176 192 256 192 S336 352 416 352" fill="none" stroke="var(--warm)" strokeWidth="40" strokeLinecap="round" />
    <path d="M96 264 H416" stroke="var(--cool)" strokeWidth="20" strokeDasharray="28 22" strokeLinecap="round" />
  </svg>
);
