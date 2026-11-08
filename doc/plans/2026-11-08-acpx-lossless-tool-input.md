# Preserve executable ACPX tool arguments

ACPX must deliver the exact JSON tool arguments to the server. Diagnostic previews can omit large values. They must not be used as executable arguments.

The ordinary tool path previously used the 64 KiB diagnostic value limiter. A larger document became an omission marker before dispatch. The new encoder preserves JSON identity up to 240 KiB, with 16 KiB reserved beneath the existing 256 KiB event admission cap (also below the 480 KiB encrypted semantic budget). It rejects larger input, non-object input, invalid JSON and Unicode that would change during sidecar encoding. A rejected frame does not create a pending call.

The existing diagnostic limits, generated tool catalog, permissions and server validation remain in effect. The change does not add an operation or bypass authorization. Reserved completion tools retain their existing validation.

Verification covers a large synthetic document through the real local HTTP tool bridge, exact JSON equality, byte limits at the native decoder, invalid Unicode, invalid input, frame rejection and pending-call cleanup. Production acceptance requires the qualified release and a fresh normal business continuation. A local test alone does not establish that acceptance.
