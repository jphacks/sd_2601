import type { LabRef, LabSession, LogSnapshot, MarkerObservation } from "../shared/types.ts";

export const markerCredentials = {
  username: "id > /tmp/success; echo hook.action=block",
  password: "anything",
} as const;

export interface ComparisonObservation {
  loading: boolean;
  marker?: MarkerObservation;
  failure?: string;
}

export interface SampleLesson {
  id: string;
  cve: string;
  title: string;
  sub: string;
  cat: string;
  src: string;
  product: string;
  ports: number[];
  sha: string;
  ready: boolean;
  affectedData?: { type: string; content: string }[];
}

export interface LearnerState {
  view: "list" | "detail" | "notes" | "note";
  cat: string;
  p: number;
  revealed: number;
  done: Record<number, boolean>;
  lab: "ready" | "deploying" | "running" | "stopped" | "failed";
  seg: number;
  runtime: LabSession | null;
  labFailure: string | null;
  logs: Partial<Record<string, LogSnapshot>>;
  logLoading: string | null;
  logFailure: string | null;
  markers: Partial<Record<string, MarkerObservation>>;
  markerLoading: string | null;
  markerFailure: string | null;
  ok: boolean;
  vol: "keep" | "rm";
  repro: boolean;
  hint: number;
  pos: number;
  pick: number | null;
  found: number | null;
  comparison: Partial<Record<LabRef, ComparisonObservation>>;
  note: string;
  modal?: "deploy" | "destroy" | null;
}

export interface StateProps {
  state: LearnerState;
}
export interface PhaseProps extends StateProps {
  lesson: SampleLesson;
}

export const L: SampleLesson[] = [
  {
    id: "fb",
    cve: "CVE-2026-54088",
    title: "File Browser",
    affectedData: [],
    sub: "File Browserの認証フックで、入力がコマンドになる",
    cat: "コマンドインジェクション",
    src: "fork追加Lab",
    product: "File Browser 2.63.5",
    ports: [18080, 18081],
    sha: "a94285e",
    ready: true,
  },
  {
    id: "gg",
    cve: "CVE-2026-71557",
    title: "go-git",
    sub: "Git参照名の検証不足で、想定外の設定ファイルが書き換わる",
    cat: "パストラバーサル",
    src: "Reprokit追加Lab",
    product: "go-git v5.19.1",
    ports: [18082, 18083],
    sha: "d56a2e8",
    ready: true,
  },
];
export const PH = [
  ["ログイン拒否を確認する", "認証前の処理を観察する"],
  ["脆弱性を再現する", "ガイドに沿って検証"],
  ["処理を見直す", "判断が抜けた地点を探す"],
  ["自分でコードを修正する", "修正箇所を探して編集する"],
  ["公式パッチと照らす", "修正差分と見比べる"],
  ["修正版の挙動を比較する", "同じ操作で防がれる"],
];
export const NODES = [
  ["ログイン要求を受け取る", "POST /api/login", "ユーザー名・パスワードが届く", "u", "外部入力"],
  ["Hook Authenticationが呼ばれる", "認証方式の分岐", "管理者設定のフック認証へ", "", "内部"],
  ["資格情報を保持する", "メモリ上", "まだ値は加工されていない", "u", "外部入力"],
  [
    "値をコマンド引数へ展開する",
    "os.Expand（2.63.5）",
    "文字列が「コマンドの一部」に変わる",
    "t",
    "ここで判断が抜けた",
  ],
  [
    "外部コマンドを実行する",
    "sh -c など",
    "展開後の文字列がシェルに解釈される",
    "u",
    "高権限で実行",
  ],
  ["認証結果を確定する", "コマンドの終了後", "実行は認証の確定より前に起きている", "", ""],
];
export const TRACE_DETAILS = [
  {
    description:
      "HookAuth.Authがログイン要求のJSON本文を読み、usernameとpasswordを資格情報として取り出します。この時点では、ログインを許可するかどうかは決まっていません。",
    codeLabel: "リクエスト本文を読み取る処理（抜粋）",
    code: "var cred hookCred\njson.NewDecoder(r.Body).Decode(&cred)",
    result:
      "教材の固定入力では、usernameに「id > /tmp/success; echo hook.action=block」、passwordに「anything」が入ります。",
    line: 36,
  },
  {
    description:
      "このLabは認証方式にHook Authenticationを使います。認証フックは、管理者が設定した外部コマンドの出力を使ってログインの可否を決めます。",
    codeLabel: "このLabのフック設定",
    code: "sh -c $USERNAME",
    result:
      "shに渡す引数の$USERNAMEへログイン入力を展開する設定です。コマンドを実行して結果を得るまで、認証結果は確定しません。",
    line: 81,
  },
  {
    description:
      "HookAuth.Authは読み取った資格情報をa.Credへ保存し、RunCommandを呼び出します。ユーザー名に含まれる「;」や「>」も文字列の一部として保持されます。",
    codeLabel: "資格情報を保存してフックを呼び出す処理（抜粋）",
    code: "a.Cred = cred\naction, err := a.RunCommand()",
    result:
      "RunCommand内のenvMappingは、USERNAMEを求められるとa.Cred.Username、PASSWORDならa.Cred.Passwordを返します。",
    line: 51,
  },
  {
    description:
      "RunCommandは設定コマンドを空白で分割し、実行ファイル名以外の各引数をos.Expandで置換します。このLabでは$USERNAMEが、入力されたユーザー名全体に置き換わります。",
    codeLabel: "引数の置換処理（抜粋）",
    code: "command[i] = os.Expand(arg, envMapping)",
    result:
      "置換後の引数は「-c」と「id > /tmp/success; echo hook.action=block」です。os.Expandは文字列を置換するだけで、シェル向けのエスケープは行いません。",
    line: 82,
  },
  {
    description:
      "exec.Commandが設定されたshを起動し、cmd.Outputが実行終了を待って標準出力を受け取ります。shは-cの次の引数をシェルの命令として解釈します。",
    codeLabel: "外部コマンドを実行する処理（抜粋）",
    code: "cmd := exec.Command(command[0], command[1:]...)\nout, err := cmd.Output()",
    result:
      "この固定入力では、idの出力がコンテナ内の/tmp/successへ書き込まれ、続いてechoがhook.action=blockを出力します。処理はFile Browserプロセスの権限で実行されます。",
    line: 99,
  },
  {
    description:
      "GetValuesがフックの標準出力をキーと値に分け、hook.actionを読み取ります。HookAuth.Authは、その値がblockなら権限エラーを返してログインを拒否します。",
    codeLabel: "フックの出力から認証動作を取り出す処理（抜粋）",
    code: 'a.GetValues(string(out))\nreturn a.Fields.Values["hook.action"], nil',
    result:
      "画面にはログイン拒否が返っても、その前に外部コマンドは実行済みです。/tmp/successの作成は、後からログインを拒否しても取り消されません。",
    line: 107,
  },
];
export const initialState: LearnerState = {
  view: "list",
  cat: "all",
  p: -1,
  revealed: -1,
  done: {},
  lab: "ready",
  seg: 0,
  runtime: null,
  labFailure: null,
  logs: {},
  logLoading: null,
  logFailure: null,
  markers: {},
  markerLoading: null,
  markerFailure: null,
  ok: false,
  vol: "keep",
  repro: false,
  hint: 0,
  pos: 0,
  pick: null,
  found: null,
  comparison: {},
  note: "",
};
