import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/api_exception.dart';
import '../api/generated/api.dart';
import '../auth/auth_service.dart';
import '../auth/session_controller.dart';
import '../profile/profile_providers.dart';
import '../theme/app_theme.dart';
import '../widgets/app_frame.dart';
import '../widgets/async_value_view.dart';
import '../widgets/form_field_frame.dart';
import '../widgets/suggestion_field.dart';
import 'legal_dialog.dart';

/// 2.2.1 初回オンボーディング画面（6ステップ）。
///
/// Step1 自宅（必須）→ Step2 よく使う駅（任意）→ Step3 徒歩速度・準備時間 →
/// Step4 優先条件 → Step5 カレンダー連携（任意）→ Step6 利用同意（必須）。
/// 最後の「完了」でプロファイルを保存し、ホームへ進む。途中でやめた場合は何も保存せず、
/// 次にログインしたときに Step1 からやり直す。
class OnboardingScreen extends ConsumerWidget {
  const OnboardingScreen({super.key});

  static const title = '初回設定';
  static const stepCount = 6;
  static const logoutLabel = 'ログアウト';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(profileProvider);
    // 取得できたら、その値（徒歩速度・準備時間・優先条件の初期値）で入力を始める
    if (profile case AsyncData(:final value) when !profile.isLoading) {
      return _OnboardingWizard(initial: value);
    }
    return AppFrame(
      title: title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AsyncValueView<Profile>(
            value: profile,
            onRetry: () => ref.invalidate(profileProvider),
            builder: (_) => const SizedBox.shrink(),
          ),
          const SizedBox(height: 16),
          const Align(alignment: Alignment.centerLeft, child: _LogoutButton()),
        ],
      ),
    );
  }
}

class _OnboardingWizard extends ConsumerStatefulWidget {
  const _OnboardingWizard({required this.initial});

  final Profile initial;

  @override
  ConsumerState<_OnboardingWizard> createState() => _OnboardingWizardState();
}

class _OnboardingWizardState extends ConsumerState<_OnboardingWizard> {
  /// いまのステップ（0 始まり。表示は +1）
  int _step = 0;

  // Step1 自宅
  late final _homeAddress = TextEditingController(
    text: widget.initial.homeAddress ?? '',
  );

  /// 候補から選んだ住所の ID。入力欄を書き換えたら消す（選び直してもらう）
  String? _homePlaceId;
  String? _homeError;

  // Step2 よく使う駅
  final _stationInput = TextEditingController();
  late final List<FrequentStation> _stations = [
    ...widget.initial.frequentStations,
  ];
  String? _stationError;

  // Step3 徒歩速度・準備時間
  late WalkingSpeed _walkingSpeed = widget.initial.walkingSpeed;
  late final _preparationTime = TextEditingController(
    text: '${widget.initial.preparationTimeMinutes}',
  );
  String? _preparationTimeError;

  // Step4 優先条件
  late PriorityCondition _priority = widget.initial.priorityCondition;

  // Step6 利用同意
  bool _consent = false;
  String? _consentError;

  bool _submitting = false;

  /// 保存に失敗したときのメッセージ（項目に結び付かないもの）
  String? _submitError;

  /// ステップの見出し。ステップが変わったら、ここへフォーカスを移す
  final _headingFocus = FocusNode(debugLabel: 'onboarding-heading');

  /// 自宅住所の入力欄
  final _homeFocus = FocusNode(debugLabel: 'onboarding-home-address');

  bool get _isLastStep => _step == OnboardingScreen.stepCount - 1;

  @override
  void dispose() {
    _headingFocus.dispose();
    _homeFocus.dispose();
    _homeAddress.dispose();
    _stationInput.dispose();
    _preparationTime.dispose();
    super.dispose();
  }

  /// いまのステップの入力を確かめる。問題があればエラーを出して false を返す。
  bool _validateStep() {
    switch (_step) {
      case 0:
        final error = _homeAddress.text.trim().isEmpty
            ? '自宅住所を入力してください'
            : _homePlaceId == null
            ? '自宅住所は候補から選んでください'
            : null;
        setState(() => _homeError = error);
        return error == null;
      case 2:
        final error = validatePreparationTime(_preparationTime.text);
        setState(() => _preparationTimeError = error);
        return error == null;
      case 5:
        final error = _consent ? null : '利用への同意が必要です';
        setState(() => _consentError = error);
        return error == null;
      default:
        return true;
    }
  }

  void _back() {
    if (_step == 0 || _submitting) return;
    setState(() {
      _step--;
      _submitError = null;
    });
    _focusAfterBuild(_headingFocus);
  }

  Future<void> _next() async {
    if (_submitting || !_validateStep()) return;
    if (!_isLastStep) {
      setState(() => _step++);
      // ステップの見出しへ移る（キーボード・読み上げで、新しいステップの先頭から続けられる）
      _focusAfterBuild(_headingFocus);
      return;
    }
    await _complete();
  }

  /// プロファイルを保存し、初回設定を完了にする。
  Future<void> _complete() async {
    setState(() {
      _submitting = true;
      _submitError = null;
    });
    try {
      await ref
          .read(apiProvider)
          .profile
          .updateProfile(
            body: ProfileUpdate(
              homeAddress: _homeAddress.text.trim(),
              homePlaceId: _homePlaceId,
              frequentStations: _stations,
              walkingSpeed: _walkingSpeed,
              preparationTimeMinutes: int.parse(_preparationTime.text.trim()),
              priorityCondition: _priority,
              acceptTerms: true,
              completeOnboarding: true,
            ),
          );
      if (!mounted) return;
      // 保存中の表示のまま、画面を離れる（ここでプロファイルを取り直すと、一瞬読み込み中に変わる）。
      // 状態が変わると、画面遷移の制御（app_router.dart）がホームへ送る
      ref.read(sessionControllerProvider.notifier).markOnboardingCompleted();
    } on Object catch (error) {
      if (!mounted) return;
      _showSaveFailure(ApiException.from(error));
    }
  }

  /// 保存の失敗を画面に出す。サーバが項目別のエラーを返したら、その項目のステップへ戻す。
  void _showSaveFailure(ApiException failure) {
    final fields = failure.fieldErrors;
    String? first(bool Function(String field) test) {
      for (final entry in fields.entries) {
        if (test(entry.key)) return entry.value;
      }
      return null;
    }

    final home = first((f) => f == 'homeAddress' || f == 'homePlaceId');
    final stations = first((f) => f.startsWith('frequentStations'));
    final preparation = first((f) => f == 'preparationTimeMinutes');
    final consent = first((f) => f == 'acceptTerms');
    final errorStep = home != null
        ? 0
        : stations != null
        ? 1
        : preparation != null
        ? 2
        : null;

    setState(() {
      _submitting = false;
      _homeError = home;
      _stationError = stations;
      _preparationTimeError = preparation;
      _consentError = consent;
      if (home != null) _homePlaceId = null; // 住所を確認できなかったので、選び直してもらう
      if (errorStep != null) _step = errorStep;
      // 項目に結び付けられなかった失敗は、ボタンの上に出す
      _submitError = errorStep == null && consent == null
          ? failure.message
          : null;
    });
    if (home != null) {
      // 住所の欄へ移る。候補の一覧も開き直すので、そのまま選び直せる
      _focusAfterBuild(_homeFocus);
    } else if (errorStep != null) {
      _focusAfterBuild(_headingFocus);
    }
  }

  /// 画面を描き直したあとで、[node] にフォーカスを移す。
  void _focusAfterBuild(FocusNode node) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) node.requestFocus();
    });
  }

  Future<List<AddressSuggestionListItemsItem>> _searchAddresses(
    String query,
  ) async =>
      (await ref.read(apiProvider).profile.suggestAddresses(q: query)).items;

  Future<List<StationSuggestionListItemsItem>> _searchStations(
    String query,
  ) async =>
      (await ref.read(apiProvider).profile.suggestStations(q: query)).items;

  void _addStation(StationSuggestionListItemsItem station) {
    setState(() {
      if (_stations.length >= maxFrequentStations) {
        _stationError = 'よく使う駅は$maxFrequentStations件まで登録できます。これ以上は追加できません';
      } else if (_stations.any((s) => s.stationCode == station.stationCode)) {
        _stationError = '「${station.stationName}」は登録済みです';
      } else {
        _stations.add(
          FrequentStation(
            stationCode: station.stationCode,
            stationName: station.stationName,
          ),
        );
        _stationError = null;
        _stationInput.clear();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final stepNumber = _step + 1;
    return AppFrame(
      title: OnboardingScreen.title,
      // 広い画面でも、本文と同じ幅に収める
      footer: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: _contentMaxWidth),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_submitError case final message?)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: FieldErrorText(message),
                ),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      key: const Key('onboarding-back'),
                      onPressed: _step == 0 || _submitting ? null : _back,
                      child: const Text('戻る'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton(
                      key: const Key('onboarding-next'),
                      onPressed: _submitting ? null : _next,
                      child: Text(
                        _submitting
                            ? '保存中…'
                            : _isLastStep
                            ? '完了'
                            : '次へ',
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: _contentMaxWidth),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _ProgressBar(step: stepNumber),
              const SizedBox(height: 16),
              Focus(
                focusNode: _headingFocus,
                skipTraversal: true,
                child: Semantics(
                  header: true,
                  child: Text(
                    _stepTitles[_step],
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              // ラジオボタン・チェックボックスの行（ListTile）は、押したときの効果を描く土台が要る
              Material(
                type: MaterialType.transparency,
                child: switch (_step) {
                  0 => _buildHomeStep(),
                  1 => _buildStationStep(),
                  2 => _buildWalkingStep(),
                  3 => _buildPriorityStep(),
                  4 => _buildCalendarStep(),
                  _ => _buildConsentStep(),
                },
              ),
              const SizedBox(height: 24),
              const Align(
                alignment: Alignment.centerLeft,
                child: _LogoutButton(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 本文と下部のボタンの最大幅
  static const _contentMaxWidth = 560.0;

  static const _stepTitles = [
    'Step 1: 自宅',
    'Step 2: よく使う駅（任意）',
    'Step 3: 徒歩速度・準備時間',
    'Step 4: 優先条件',
    'Step 5: カレンダー連携（任意）',
    'Step 6: 利用同意',
  ];

  static const _homeLabel = '自宅住所';
  static const _stationLabel = 'よく使う駅';

  Widget _buildHomeStep() {
    return FormFieldFrame(
      label: _homeLabel,
      required: true,
      errorText: _homeError,
      labelsChild: false,
      footer: const _Hint('住所を入力し、表示された候補から選んでください。出発時刻と経路の計算に使います。'),
      child: SuggestionField<AddressSuggestionListItemsItem>(
        fieldKey: const Key('onboarding-home-address'),
        controller: _homeAddress,
        focusNode: _homeFocus,
        semanticLabel: FormFieldFrame.semanticLabelOf(
          _homeLabel,
          required: true,
        ),
        // 文字は入っているが候補を選んでいないとき（保存時に住所を確認できず戻されたときなど）は、
        // 入力欄に移っただけで候補を出す
        searchOnFocus: _homePlaceId == null,
        onSubmitted: _next,
        maxLength: homeAddressMaxLength,
        hintText: '例：東京都千代田区丸の内1丁目',
        search: _searchAddresses,
        itemLabel: (item) => item.description,
        onChanged: (_) {
          // 書き換えたら、前に選んだ候補は無効にする（住所と座標がずれないように）
          if (_homePlaceId != null || _homeError != null) {
            setState(() {
              _homePlaceId = null;
              _homeError = null;
            });
          }
        },
        onSelected: (item) => setState(() {
          _homeAddress.text = item.description;
          _homePlaceId = item.placeId;
          _homeError = null;
        }),
      ),
    );
  }

  Widget _buildStationStep() {
    return FormFieldFrame(
      label: _stationLabel,
      errorText: _stationError,
      labelsChild: false,
      footer: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Hint(
            '駅名を入力し、候補から選ぶと登録されます（${_stations.length}/$maxFrequentStations件）。'
            '登録しなくても先へ進めます。',
          ),
          if (_stations.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final station in _stations)
                  InputChip(
                    label: Text(station.stationName),
                    deleteButtonTooltipMessage: '${station.stationName}を削除',
                    onDeleted: () => setState(() {
                      _stations.remove(station);
                      _stationError = null;
                    }),
                  ),
              ],
            ),
          ],
        ],
      ),
      child: SuggestionField<StationSuggestionListItemsItem>(
        fieldKey: const Key('onboarding-station'),
        controller: _stationInput,
        semanticLabel: FormFieldFrame.semanticLabelOf(_stationLabel),
        maxLength: stationNameMaxLength,
        hintText: '例：新宿',
        search: _searchStations,
        itemLabel: (item) => item.stationName,
        itemDetail: (item) => item.prefecture,
        onChanged: (_) {
          if (_stationError != null) setState(() => _stationError = null);
        },
        onSelected: _addStation,
      ),
    );
  }

  Widget _buildWalkingStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FormFieldFrame(
          label: '徒歩速度',
          child: DropdownButtonFormField<WalkingSpeed>(
            key: const Key('onboarding-walking-speed'),
            initialValue: _walkingSpeed,
            items: [
              for (final speed in WalkingSpeed.values)
                DropdownMenuItem(
                  value: speed,
                  child: Text(walkingSpeedLabel(speed)),
                ),
            ],
            onChanged: (speed) {
              if (speed != null) setState(() => _walkingSpeed = speed);
            },
          ),
        ),
        FormFieldFrame(
          label: '準備時間（分）',
          errorText: _preparationTimeError,
          footer: const _Hint(
            '外出の準備にかかる時間の目安です（$preparationTimeMin〜$preparationTimeMax分）。',
          ),
          child: TextField(
            key: const Key('onboarding-preparation-time'),
            controller: _preparationTime,
            keyboardType: TextInputType.number,
            inputFormatters: [LengthLimitingTextInputFormatter(4)],
            onChanged: (_) {
              if (_preparationTimeError != null) {
                setState(() => _preparationTimeError = null);
              }
            },
            onSubmitted: (_) => _next(),
          ),
        ),
      ],
    );
  }

  Widget _buildPriorityStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          label: '優先条件',
          child: RadioGroup<PriorityCondition>(
            groupValue: _priority,
            onChanged: (condition) {
              if (condition != null) setState(() => _priority = condition);
            },
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final condition in PriorityCondition.values)
                  RadioListTile<PriorityCondition>(
                    key: Key('onboarding-priority-${condition.name}'),
                    value: condition,
                    title: Text(priorityConditionLabel(condition)),
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 4),
        // 補足は選択肢のグループの外に置く（グループの読み上げ名に混ざらないように）
        const _Hint('行動計画を作るときに重視する方針です。あとから設定画面で変更できます。'),
      ],
    );
  }

  Widget _buildCalendarStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 連携の処理は WBS 8.1・8.2 で実装する。それまでは押せない状態で出す
        const OutlinedButton(
          key: Key('onboarding-calendar-google'),
          onPressed: null,
          child: Text('Google カレンダー連携'),
        ),
        const SizedBox(height: 8),
        const OutlinedButton(
          key: Key('onboarding-calendar-outlook'),
          onPressed: null,
          child: Text('Outlook カレンダー連携'),
        ),
        const SizedBox(height: 8),
        const _Hint('カレンダー連携は準備中です。連携しなくても先へ進めます。'),
      ],
    );
  }

  Widget _buildConsentStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('次の内容を確認し、同意のうえで「完了」を押してください。'),
        const SizedBox(height: 8),
        for (final item in consentItems)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('・'),
                Expanded(child: Text(item)),
              ],
            ),
          ),
        const SizedBox(height: 4),
        Wrap(
          spacing: 8,
          children: [
            for (final document in LegalDocument.values)
              TextButton(
                key: Key('onboarding-legal-${document.name}'),
                onPressed: () => showLegalDocument(context, document),
                child: Text(
                  document.title,
                  style: const TextStyle(decoration: TextDecoration.underline),
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        FormFieldFrame(
          label: '利用同意',
          required: true,
          errorText: _consentError,
          child: CheckboxListTile(
            key: const Key('onboarding-consent'),
            value: _consent,
            onChanged: _submitting
                ? null
                : (value) => setState(() {
                    _consent = value ?? false;
                    if (_consent) _consentError = null;
                  }),
            title: const Text(consentLabel),
            controlAffinity: ListTileControlAffinity.leading,
            contentPadding: EdgeInsets.zero,
            dense: true,
          ),
        ),
      ],
    );
  }
}

/// Step6 のチェックボックスの文言。
const consentLabel = '利用規約・プライバシーポリシーと上記の内容に同意する';

/// Step6 に出す同意事項（要件 3.3.2）。
///
/// Web 版は位置情報を取得しない。位置情報を使う出発の検知はスマートフォンアプリ版の機能なので、
/// Web 版の利用者が「位置情報を取られる」と誤解しないように書き分ける。
const consentItems = [
  '入力した自宅住所・よく使う駅・用事の内容を、行動計画の作成（出発時刻・経路・立寄り先の提案）に利用します。',
  'Web版では、端末の位置情報を取得しません。',
  'スマートフォンアプリ版では、出発の検知に位置情報を利用します。位置情報は準備時間の学習だけに使い、'
      '常時の送信・保存は行いません（Web版は対象外です）。',
];

/// 進捗バー（画面の見本の `.progress-bar-section`）。「進捗: 3/6」のように出す。
class _ProgressBar extends StatelessWidget {
  const _ProgressBar({required this.step});

  /// いまのステップ（1 始まり）
  final int step;

  @override
  Widget build(BuildContext context) {
    const total = OnboardingScreen.stepCount;
    return Semantics(
      label: '進捗 $step/$total',
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '進捗: $step/$total',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
            const SizedBox(height: 4),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: step / total,
                minHeight: 8,
                backgroundColor: AppColors.border,
                color: AppColors.primary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 入力欄の下に出す補足の文。
class _Hint extends StatelessWidget {
  const _Hint(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
    );
  }
}

/// 初回設定の途中でやめるためのログアウト。
class _LogoutButton extends ConsumerWidget {
  const _LogoutButton();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return TextButton(
      key: const Key('onboarding-logout'),
      onPressed: () async {
        final messenger = ScaffoldMessenger.of(context);
        try {
          await ref.read(sessionControllerProvider.notifier).signOut();
        } on AuthFailure catch (failure) {
          messenger.showSnackBar(SnackBar(content: Text(failure.message)));
        }
      },
      child: const Text(
        OnboardingScreen.logoutLabel,
        style: TextStyle(decoration: TextDecoration.underline),
      ),
    );
  }
}
