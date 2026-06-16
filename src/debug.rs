//! Optional debug logging, gated on `RUMONGO_DEBUG=1`.
//! Logs to stderr — query start/finish with doc count + elapsed time.

/// True when `RUMONGO_DEBUG` is set to `1` or `true`.
pub fn enabled() -> bool {
    matches!(
        std::env::var("RUMONGO_DEBUG").ok().as_deref(),
        Some("1") | Some("true")
    )
}

/// Emit a debug line (only call when [`enabled`] is true).
pub fn log(args: std::fmt::Arguments<'_>) {
    eprintln!("[rumongo] {args}");
}

#[macro_export]
macro_rules! dbg_log {
    ($($arg:tt)*) => {
        if $crate::debug::enabled() {
            $crate::debug::log(format_args!($($arg)*));
        }
    };
}
