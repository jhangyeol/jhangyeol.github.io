// Short explanations shown in click-to-open popovers.
export const INFO = {
  sgbt: {
    title: "SGBT",
    body: `<b>Streaming Gradient Boosted Trees</b>. 데이터가 한 개씩 도착하면 S개의 트리를 <b>순서대로</b> 갱신하는 온라인 부스팅.
      <ul><li>예측: F(x) = Σ<sub>k</sub> η·f<sub>k</sub>(x), 분류는 p = σ(F)</li>
      <li>k번째 트리는 앞선 트리들의 합 F<sub>k−1</sub>에 대한 gradient g, hessian h를 받아 <b>−g/h</b>를 h 가중치로 학습 (XGBoost식 2차 근사)</li>
      <li>각 트리가 스스로 drift를 감지하면 <b>교체(swap)</b></li>
      <li>학습·평가는 <b>prequential</b>: 샘플마다 먼저 예측하고 곧바로 그 label로 학습 (label delay 없음)</li></ul>
      <span class="muted">트리 단위 교체로 단순화한 구현입니다. (Gunasekara et al., 2024)</span>`,
  },
  dataset: {
    title: "Dataset",
    body: `<ul><li><b>2-D synthetic</b>: 입력이 2개라 경계를 그대로 볼 수 있음. 점선 = 실제 concept</li>
      <li><b>Synthetic (MOA / high-dim)</b>: AGR, Friedman. 실제 concept를 알고 있음</li>
      <li><b>Real-world</b>: NOAA, ELEC. 실제 drift 시점을 모름. 속성은 순위 기준 8-bit로 양자화</li></ul>`,
  },
  drift: {
    title: "Drift 유형",
    body: `<ul><li><b>Abrupt</b>: 경계 시점에 즉시 바뀜</li>
      <li><b>Gradual</b>: 전환 구간 동안 옛/새 concept가 확률적으로 섞여 나옴</li>
      <li><b>Incremental</b>: concept가 연속적으로 조금씩 이동</li>
      <li><b>None</b>: 정상(stationary) 스트림, 오탐 확인용</li></ul>
      AGR_a / AGR_g는 drift 유형이 고정, 실제 데이터에는 적용되지 않습니다.`,
  },
  plot: {
    title: "Feature space",
    body: `배경 = 현재 시점 모델의 예측. 점 = 최근 도착한 샘플(오래될수록 흐림).
      <ul><li>실선: 모델 decision boundary (p = 0.5) / 회귀는 예측 등고선</li>
      <li>점선: 실제 concept의 경계 (알 수 있을 때만)</li>
      <li>트리를 선택하면 그 트리의 <b>분할 영역</b>이 겹쳐 보입니다</li></ul>`,
  },
  slice: {
    title: "2-D slice",
    body: `입력이 3개 이상이면 고른 두 축으로 자른 <b>단면</b>을 그립니다. 나머지 속성은 최근 샘플들의 <b>중앙값</b>으로 고정. 점은 최근 샘플을 두 축에 투영한 것이라 배경과 완전히 일치하지 않을 수 있습니다.`,
  },
  overlay: {
    title: "Overlay",
    body: `<ul><li><b>Ensemble</b>: 전체 F(x)</li><li><b>This tree</b>: 선택한 트리 하나의 기여 η·f<sub>k</sub>(x)</li>
      <li><b>Up to #k</b>: 1…k번째 트리까지의 부분합 F<sub>k</sub>(x). 뒤쪽 트리가 무엇을 보정하는지 비교해 보세요</li></ul>`,
  },
  ensemble: {
    title: "Boosting stages",
    body: `카드 하나 = boosting 단계 하나. #1이 가장 큰 구조를 잡고 뒤 단계일수록 남은 잔차를 보정합니다.
      <ul><li>미니 트리: 분할 노드 색 = 사용한 feature, 잎 색 = 잎 값의 부호/크기</li>
      <li>하단 막대: drift detector 수치</li>
      <li><b>bg</b>: 경고 후 함께 학습 중인 백그라운드 트리</li></ul>클릭하면 상세 정보.`,
  },
  detector: {
    title: "Drift detector",
    body: `각 단계는 자기 오차 e = (g + h·f<sub>k</sub>)²의 <b>단기 평균</b>과 <b>장기 평균</b>을 비교합니다.
      <ul><li>단기 평균이 장기 평균보다 <b>비율</b>로도 크고 <b>통계적으로도 유의</b>(z-score)해야 신호로 봄</li>
      <li><span class="warnc">경고선</span>을 넘으면 백그라운드 트리 생성</li>
      <li><span class="driftc">drift선</span>을 넘으면 백그라운드 트리로 교체</li>
      <li>경고가 사라지면 백그라운드 트리는 폐기</li></ul>`,
  },
  swap: {
    title: "Swap log",
    body: `트리 교체 기록. <b>bg</b> 표시는 경고 시점부터 미리 학습한 백그라운드 트리가 투입된 경우. 행을 클릭하면 그 시점으로 이동해 퇴역한 트리를 보여줍니다.`,
  },
  timeline: {
    title: "Timeline",
    body: `<ul><li>Prequential: 샘플이 도착할 때마다 <b>먼저 예측(test)</b>하고, 바로 공개되는 label로 <b>학습(train)</b> (label delay 없음)</li>
      <li><b>Window</b>: 최근 200개 평균 (곡선) · <b>Overall</b>: 처음부터 지금까지의 평균</li>
      <li>점선: 같은 스트림·설정에서 <b>교체를 끈</b> SGBT</li>
      <li>세로 점선/음영: concept 변화 시점·전환 구간</li>
      <li>아래 줄무늬: 단계별 <span class="warnc">경고 구간</span>과 <span class="driftc">교체</span></li></ul>클릭/드래그로 이동.`,
  },
  tree: {
    title: "Tree",
    body: `Hoeffding 방식의 streaming 회귀 트리. 잎이 grace period만큼 샘플을 모을 때마다 분할 후보를 평가하고, 최선 분할이 차선보다 통계적으로 확실히 좋을 때만(Hoeffding bound) 분할합니다.
      <br>잎 값 = −ΣG / (ΣH + λ). 그림은 휠/버튼으로 확대, 드래그로 이동, 더블클릭으로 맞춤.`,
  },
  history: {
    title: "Slot history",
    body: `이 단계 자리를 거쳐 간 트리들. 옅은 구간은 백그라운드로 학습하던 기간.`,
  },
  trees: { title: "Trees (S)", body: `boosting 단계 수. 많을수록 표현력↑, 계산량↑.` },
  eta: { title: "Learning rate η", body: `각 트리 출력에 곱하는 축소 계수. 작으면 안정적이지만 느리게 수렴.` },
  grace: { title: "Grace period", body: `잎이 분할을 다시 시도하기 전 모아야 하는 샘플 수.` },
  delta: { title: "Split confidence δ", body: `Hoeffding bound의 신뢰도. 작을수록 더 많은 증거가 있어야 분할.` },
  tau: { title: "Tie threshold τ", body: `두 후보가 비슷해도 bound가 τ보다 작아지면 그냥 분할.` },
  lambda: { title: "L2 λ", body: `잎 값 −G/(H+λ)의 정규화. 샘플이 적은 잎의 값을 0 쪽으로 당김.` },
  maxDepth: { title: "Max depth", body: `트리 최대 깊이.` },
  replace: { title: "Tree replacement", body: `끄면 drift 감지·교체 없이 트리가 계속 자라기만 합니다.` },
  sensitivity: { title: "Detector sensitivity", body: `높을수록 경고/drift선이 낮아져 더 자주 교체.` },
  noise: { title: "Noise", body: `분류: 라벨 뒤집힘 확률. 회귀: 가우시안 잡음 σ.` },
  length: { title: "Stream length", body: `학습할 샘플 수 (최대 30,000). 실제 데이터는 데이터 길이까지.` },
  period: { title: "Concept period", body: `concept가 바뀌는 간격(샘플 수). 4개의 concept가 순환합니다.` },
};
