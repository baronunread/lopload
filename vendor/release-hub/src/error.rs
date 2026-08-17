/// Errors produced by release discovery, download, verification, and installation.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// GitHub API or connector error.
    #[error(transparent)]
    GitHub(#[from] octocrab::Error),
    /// Filesystem or process I/O error.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Semantic-version parsing error.
    #[error(transparent)]
    Semver(#[from] semver::Error),
    /// HTTP request or response-body error.
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
    /// Minisign decode or verification error.
    #[error(transparent)]
    Minisign(#[from] minisign_verify::Error),
    /// Generic HTTP protocol or header construction error.
    #[error(transparent)]
    Http(#[from] http::Error),
    /// Invalid HTTP header value.
    #[error(transparent)]
    InvalidHeaderValue(#[from] http::header::InvalidHeaderValue),
    /// Invalid HTTP header name.
    #[error(transparent)]
    InvalidHeaderName(#[from] http::header::InvalidHeaderName),
    /// The current CPU architecture is not supported.
    #[error(
        "Unsupported application architecture, expected one of `x86`, `x86_64`, `arm` or `aarch64`."
    )]
    UnsupportedArch,
    /// The current operating system is not supported.
    #[error("Unsupported OS, expected one of `linux`, `darwin` or `windows`.")]
    UnsupportedOs,
    /// No suitable artifact could be found for the requested target.
    #[error("Asset not found.")]
    AssetNotFound,
    /// The install target path could not be derived from the executable path.
    #[error("Failed to determine updater package extract path.")]
    FailedToDetermineExtractPath,
    /// An update endpoint used an insecure transport protocol.
    #[error("The configured updater endpoint must use a secure protocol like `https`.")]
    InsecureTransportProtocol,
    /// The requested platform key was not present in the remote release metadata.
    #[error("the platform `{0}` was not found on the response `platforms` object")]
    TargetNotFound(String),
    /// A matching detached signature asset was not found for the selected artifact.
    #[error("missing signature asset for `{0}`")]
    MissingSignatureAsset(String),
    /// Generic network or transport failure represented as a message.
    #[error("`{0}`")]
    Network(String),
    /// Downloaded installer or archive bytes did not match the expected format.
    #[error("invalid updater binary format")]
    InvalidUpdaterFormat,
    /// Temporary staging directory creation failed.
    #[error("failed to create temporary directory")]
    TempDirNotFound,
    /// Windows elevation or installer execution was denied.
    #[error("Installation failed: insufficient privileges. Please run as administrator.")]
    InsufficientPrivileges,
    /// Windows installer could not proceed because files are in use.
    #[error("Installation failed: file in use. Please close the application and try again.")]
    FileInUse,
    /// Windows installer launch returned an execution error code.
    #[error("Installation failed: installer execution error. Error code: {0}")]
    InstallerExecutionFailed(i32),
    /// Windows elevation prompt was cancelled by the user.
    #[error("Installation cancelled: User declined administrator privileges.")]
    UserCancelledElevation,
    /// JSON parsing or serialization error.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// RFC3339 or other time parsing error.
    #[error(transparent)]
    Time(#[from] time::error::Parse),
    #[cfg(target_os = "macos")]
    /// ZIP archive extraction error on macOS.
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
}

/// Convenient result alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;
