# Reception and customer chat language

Customer-facing chat uses English regardless of the browser language, the SDK's
requested locale or the Chinese staff account locale. Reception staff continue to use
Chinese, with product names and professional terms such as API, CRM, CAPI and Ads
preserved. Customer messages, customer names and identifiers are never translated.

The widget-only initializer sets `lang=en` and narrows accepted locales before the
native widget bundle starts. It does not update account or user language settings.
Native pre-chat validation uses FormKit's English inline errors; browser-native
validation is disabled because its language follows the browser installation.
The offline form also uses inline English validation, preserves entered values on
failure and reuses its submission ID for retries. Existing conversations remain
accessible when the team goes offline.

The reception navigation groups channels and settings, keeps the presence control
visible at narrow widths, and preserves desktop-owned presence leases. The desktop
bridge remains the only lease owner when running inside the desktop application.

## Configuration and deployment

`deploy/demo/configure-widget-ui.rb` updates only welcome copy and standard pre-chat
field labels/placeholders for an explicitly selected website inbox. Supply
`AKE_WIDGET_UI_ACCOUNT`, `AKE_WIDGET_UI_INBOX` and a new private
`AKE_WIDGET_UI_BACKUP` path to Rails runner. The script requires a pre-write backup,
preserves enabled/required flags and checks that the staff locale is unchanged.

Deploy the reviewed archive assets through the existing installation process.
The `ake_brand.rb` initializer needs a web-process restart. Static assets use
`Cache-Control: no-cache`; an already open page needs a refresh. No client binary,
API contract or database schema change is required.

Rollback restores the saved UI assets and the three widget presentation fields from
the backup, then restarts only the web process. Do not restore business databases or
change channel credentials as part of this UI rollback.

## Verification

`test/inbox-channels/ui-localization.py` requires a disposable local Chatwoot instance
and fictional fixture data. Never point it at the live office service. Supply
`AKE_UI_TEST_URL`, `AKE_UI_FIXTURE`, `AKE_UI_OUTPUT` and optionally
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` / `AKE_UI_PRIVATE_ERROR`.

It covers Chinese staff navigation, presence toggles, desktop/mobile widths,
English customer UI under a Chinese browser and parent SDK locale, required-field
validation, disabled sending, failure/retry, real disposable offline and online
submissions, delivery receipts, returning conversations and closing the embedded
widget. Online availability is simulated for that scenario; submission and receipt
checks use the disposable database. Raw errors and fixture credentials stay private.
