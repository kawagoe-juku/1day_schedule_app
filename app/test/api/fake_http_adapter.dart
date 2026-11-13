import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// 通信をせずに、決めておいた応答を返す（外部 API・サーバのモック）。受け取ったリクエストは [requests] に残る。
class FakeHttpAdapter implements HttpClientAdapter {
  FakeHttpAdapter(this._handler);

  /// JSON の応答を1つ返す。
  FakeHttpAdapter.json(int statusCode, Object? body)
    : this((_) => jsonResponse(statusCode, body));

  /// 通信エラー（サーバに届かない）を起こす。
  FakeHttpAdapter.connectionError()
    : this(
        (options) => throw DioException.connectionError(
          requestOptions: options,
          reason: 'テスト用の通信エラー',
        ),
      );

  final ResponseBody Function(RequestOptions options) _handler;

  final List<RequestOptions> requests = [];

  static ResponseBody jsonResponse(int statusCode, Object? body) =>
      ResponseBody.fromString(
        jsonEncode(body),
        statusCode,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return _handler(options);
  }

  @override
  void close({bool force = false}) {}
}
