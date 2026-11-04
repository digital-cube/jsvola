import { useI18n } from "@jsudc/react";
import { Segmented } from "@jsudc/react/ui";
import type { ReactNode } from "react";

/** The header: the brand, then the site's tools — `children` before EN / SR, `end` after it. */
export function TopBar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  const { t } = useI18n();
  return (
    <header className="topbar">
      <div className="brand" data-testid="app-name">
        <span className="brand__mark">{t("APP", "NAME")}</span>
        <span className="brand__sub">{t("APP", "TAGLINE")}</span>
      </div>
      <div className="topbar__tools">
        {children}
        <LocaleSwitch />
        {end}
      </div>
    </header>
  );
}

/** EN / SR: the strings of the site and of every `@vol-a/react` and `@jsudc/react` component. */
export function LocaleSwitch() {
  const { t, locale, locales, setLocale } = useI18n();
  return (
    <Segmented
      aria-label={t("APP", "LANGUAGE")}
      data-testid="locale-switch"
      value={locale}
      onChange={setLocale}
      options={locales.map((l) => ({ value: l, label: l.toUpperCase(), testId: `locale-${l}` }))}
    />
  );
}
