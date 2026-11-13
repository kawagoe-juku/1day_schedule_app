import 'package:dio/dio.dart';

import 'generated/api.dart';
import 'json_nulls.dart';

/// API 呼び出しの失敗の種類。
enum ApiErrorKind {
  /// サーバに届かなかった（通信できない・接続が切れた）
  network,

  /// 時間内に応答がなかった
  timeout,

  /// 入力が不正（400）。[ApiException.fieldErrors] に項目ごとの内容が入る
  validation,

  /// ログインしていない・ログインの有効期限が切れた（401）
  unauthorized,

  /// 対象がない（404）
  notFound,

  /// 現在の状態では実行できない（409）
  conflict,

  /// 1日の生成上限を超えた（429）
  rateLimited,

  /// 外部サービス（地図・乗換案内・AI・カレンダー）の失敗（502）
  externalService,

  /// 準備中の機能（501）
  featureDisabled,

  /// サーバ内部のエラー、または想定していない応答
  server,
}

/// API 呼び出しの失敗。画面はこの型だけを扱う（通信ライブラリの例外は扱わない）。
class ApiException implements Exception {
  const ApiException({
    required this.kind,
    required this.message,
    this.statusCode,
    this.requestId,
    this.fieldErrors = const {},
  });

  /// API 呼び出しで受け取った例外を [ApiException] にする。
  ///
  /// 通信処理（`createApiDio`）が変換済みの例外を入れているので、それを取り出す。
  /// それ以外（応答の読み取り失敗など）は [ApiErrorKind.server] として扱う。
  factory ApiException.from(Object error) {
    if (error is ApiException) return error;
    if (error is DioException) {
      final inner = error.error;
      return inner is ApiException ? inner : ApiException.fromDio(error);
    }
    return const ApiException(
      kind: ApiErrorKind.server,
      message: unexpectedMessage,
    );
  }

  /// 通信ライブラリの例外から作る。サーバの共通エラー形式（`ApiError`）を読み取る。
  factory ApiException.fromDio(DioException error) {
    switch (error.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        return const ApiException(
          kind: ApiErrorKind.timeout,
          message: timeoutMessage,
        );
      case DioExceptionType.connectionError:
      case DioExceptionType.cancel:
      case DioExceptionType.badCertificate:
        return const ApiException(
          kind: ApiErrorKind.network,
          message: networkMessage,
        );
      case DioExceptionType.badResponse:
      case DioExceptionType.unknown:
      // ignore: no_default_cases  今後 dio に種類が増えても「想定外」として扱う
      default:
        break;
    }

    final response = error.response;
    if (response == null) {
      // ブラウザでは、通信できないときも種類が unknown で届く
      return const ApiException(
        kind: ApiErrorKind.network,
        message: networkMessage,
      );
    }

    final statusCode = response.statusCode;
    final body = _parseErrorBody(response.data);
    if (body == null) {
      return ApiException(
        kind: _kindFromStatus(statusCode),
        message: unexpectedMessage,
        statusCode: statusCode,
      );
    }
    return ApiException(
      kind: _kindFromCode(body.code),
      message: body.message,
      statusCode: statusCode,
      requestId: body.requestId,
      fieldErrors: {
        // 同じ項目に複数あるときは、最初の1件を出す
        for (final detail in (body.details ?? const []).reversed)
          detail.field: detail.message,
      },
    );
  }

  static const networkMessage = '通信できませんでした。接続を確認して、もう一度お試しください';
  static const timeoutMessage = '応答に時間がかかっています。しばらくしてから、もう一度お試しください';
  static const unexpectedMessage = 'エラーが発生しました。しばらくしてから、もう一度お試しください';

  final ApiErrorKind kind;

  /// 利用者にそのまま見せられる日本語のメッセージ
  final String message;

  /// HTTP のステータスコード（サーバから応答があったときだけ）
  final int? statusCode;

  /// 問い合わせ・ログ調査用の ID（サーバが返したときだけ）
  final String? requestId;

  /// 入力エラーの内容。キーは API の項目名（例：`homeAddress`）
  final Map<String, String> fieldErrors;

  @override
  String toString() =>
      'ApiException(${kind.name}, status: $statusCode, requestId: $requestId)';
}

ApiErrorError? _parseErrorBody(Object? data) {
  if (data is! Map<String, Object?>) return null;
  try {
    return ApiError.fromJson(removeJsonNulls(data) as Map<String, Object?>)
        .error;
  } on Object {
    // 共通エラー形式ではない応答（CloudFront や ALB が返したエラーページなど）
    return null;
  }
}

ApiErrorKind _kindFromCode(ApiErrorErrorCode code) => switch (code) {
  ApiErrorErrorCode.validationError => ApiErrorKind.validation,
  ApiErrorErrorCode.unauthorized => ApiErrorKind.unauthorized,
  // FORBIDDEN は予約（サーバは返さない）。返ってきたら「対象がない」と同じ扱いにする
  ApiErrorErrorCode.forbidden => ApiErrorKind.notFound,
  ApiErrorErrorCode.notFound => ApiErrorKind.notFound,
  ApiErrorErrorCode.conflict => ApiErrorKind.conflict,
  ApiErrorErrorCode.rateLimited => ApiErrorKind.rateLimited,
  ApiErrorErrorCode.externalServiceError => ApiErrorKind.externalService,
  ApiErrorErrorCode.featureDisabled => ApiErrorKind.featureDisabled,
  ApiErrorErrorCode.internalError => ApiErrorKind.server,
};

ApiErrorKind _kindFromStatus(int? statusCode) => switch (statusCode) {
  401 => ApiErrorKind.unauthorized,
  404 => ApiErrorKind.notFound,
  _ => ApiErrorKind.server,
};
