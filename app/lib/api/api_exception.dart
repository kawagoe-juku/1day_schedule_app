import 'package:dio/dio.dart';

import 'generated/api.dart';

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
    return ApiException(
      // サーバが返したコードを優先し、読めなければ HTTP のステータスから決める
      kind: body?.kind ?? _kindFromStatus(statusCode),
      message: body?.message ?? unexpectedMessage,
      statusCode: statusCode,
      requestId: body?.requestId,
      fieldErrors: body?.fieldErrors ?? const {},
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

/// サーバの共通エラー形式（`{ error: { code, message, details, requestId } }`）から読めた内容。
typedef _ErrorBody = ({
  ApiErrorKind? kind,
  String? message,
  String? requestId,
  Map<String, String> fieldErrors,
});

/// 共通エラー形式を、読める範囲で読む。形式が違えば null。
///
/// 生成した型（`ApiError.fromJson`）は、知らないコードや欠けた項目が1つでもあると全体を
/// 読めなくなる。古い画面が新しいサーバの応答を受け取っても、メッセージは出せるように、
/// ここでは項目ごとに読む。
_ErrorBody? _parseErrorBody(Object? data) {
  if (data is! Map) return null;
  final error = data['error'];
  if (error is! Map) return null;

  final code = error['code'];
  final message = error['message'];
  final requestId = error['requestId'];
  final details = error['details'];
  return (
    kind: _kindFromCode(code),
    message: message is String && message.isNotEmpty ? message : null,
    requestId: requestId is String ? requestId : null,
    fieldErrors: {
      if (details is List)
        // 同じ項目に複数あるときは、最初の1件を出す
        for (final detail in details.reversed)
          if (detail is Map &&
              detail['field'] is String &&
              detail['message'] is String)
            detail['field'] as String: detail['message'] as String,
    },
  );
}

/// サーバのエラーコードから種類を決める。知らないコードなら null。
ApiErrorKind? _kindFromCode(Object? code) {
  final known = ApiErrorErrorCode.values.where((item) => item.value == code);
  if (known.isEmpty) return null;
  return switch (known.first) {
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
}

ApiErrorKind _kindFromStatus(int? statusCode) => switch (statusCode) {
  400 => ApiErrorKind.validation,
  401 => ApiErrorKind.unauthorized,
  403 || 404 => ApiErrorKind.notFound,
  409 => ApiErrorKind.conflict,
  429 => ApiErrorKind.rateLimited,
  501 => ApiErrorKind.featureDisabled,
  // 本文のない 502〜504 は、ALB・CloudFront がサーバに届かなかったときのもの（外部サービスの失敗ではない）
  _ => ApiErrorKind.server,
};
