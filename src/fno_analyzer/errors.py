class AppError(Exception):
    def __init__(
        self,
        message: str,
        code: str = "APP_ERROR",
        status: int = 500,
        provider: str | None = None,
        retryable: bool = False,
    ):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.provider = provider
        self.retryable = retryable


class InvalidParameter(AppError):
    def __init__(self, message: str, code: str = "INVALID_PARAMETER"):
        super().__init__(message, code=code, status=400)


class ConfigurationError(AppError):
    def __init__(self, message: str, code: str = "CONFIGURATION_ERROR", provider: str | None = None):
        super().__init__(message, code=code, status=503, provider=provider)


class ProviderError(AppError):
    def __init__(
        self,
        message: str,
        code: str = "PROVIDER_ERROR",
        provider: str | None = None,
        status: int = 502,
        retryable: bool = True,
    ):
        super().__init__(message, code=code, status=status, provider=provider, retryable=retryable)


class ProviderAuthError(ProviderError):
    def __init__(self, provider: str, message: str):
        super().__init__(message, code="PROVIDER_AUTH_ERROR", provider=provider)


class UpstreamNotFound(ProviderError):
    def __init__(self, provider: str, message: str):
        super().__init__(message, code="UPSTREAM_NOT_FOUND", provider=provider, status=404, retryable=False)


class UpstreamTimeout(ProviderError):
    def __init__(self, provider: str, message: str):
        super().__init__(message, code="UPSTREAM_TIMEOUT", provider=provider, status=504)
