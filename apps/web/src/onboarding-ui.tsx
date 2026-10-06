import { message as uiMessage } from './messages';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import type {
  OnboardingApplication,
  OnboardingApplicationResult,
  OnboardingState,
} from '@yelaxis/application';
import {
  onboardingSteps,
  type OnboardingDraft,
  type OnboardingStep,
  type Weekday,
} from '@yelaxis/domain';

import { accountsOffered, useAccountOptional } from './account/account-context';
import { OnboardingSignIn, welcomeAccountText } from './account/onboarding-sign-in';

const weekdayOptions: readonly (readonly [Weekday, string])[] = [
  ['monday', uiMessage('onboarding-ui.1024')],
  ['tuesday', uiMessage('onboarding-ui.1025')],
  ['wednesday', uiMessage('onboarding-ui.1026')],
  ['thursday', uiMessage('onboarding-ui.1027')],
  ['friday', uiMessage('onboarding-ui.1028')],
  ['saturday', uiMessage('onboarding-ui.1029')],
  ['sunday', uiMessage('onboarding-ui.1030')],
];

export function OnboardingJourney({
  application,
  online,
  state,
  updateState,
  onLeave,
}: {
  readonly application: OnboardingApplication;
  readonly online: boolean;
  readonly state: OnboardingState;
  readonly updateState: (state: OnboardingState) => void;
  readonly onLeave: () => void;
}): ReactNode {
  const [draft, setDraft] = useState(state.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const operationInFlight = useRef(false);
  const currentIndex = onboardingSteps.indexOf(state.step);

  useEffect(() => setDraft(state.draft), [state.profileRevision]);
  useEffect(() => heading.current?.focus(), [state.step]);

  const run = async (
    operation: () => Promise<OnboardingApplicationResult<OnboardingState>>,
  ): Promise<boolean> => {
    if (operationInFlight.current) return false;
    operationInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      updateState(result.value);
      return true;
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  };

  const navigateBack = async (): Promise<void> => {
    const prior = onboardingSteps[Math.max(0, currentIndex - 1)] ?? 'welcome';
    await run(() => application.execute({ kind: 'navigate', step: prior }));
  };

  return (
    <main className="onboarding-page" id="main-content">
      <header className="onboarding-header">
        <BrandStatic />
        <button className="text-button" type="button" onClick={onLeave}>
          {uiMessage('onboarding-ui.1031')}
        </button>
      </header>
      {!online && (
        <div className="offline-note" role="status">
          {uiMessage('onboarding-ui.1032')}
        </div>
      )}
      <div className="onboarding-layout">
        <aside className="onboarding-progress" aria-label={uiMessage('onboarding-ui.1033')}>
          <p className="eyebrow">{uiMessage('onboarding-ui.1034')}</p>
          <p aria-live="polite">
            {uiMessage('onboarding-ui.1035')}
            {currentIndex + 1}
            {uiMessage('actions-ui.321')}
            {onboardingSteps.length}
          </p>
          <progress max={onboardingSteps.length} value={currentIndex + 1}>
            {currentIndex + 1}
            {uiMessage('actions-ui.321')}
            {onboardingSteps.length}
          </progress>
          <ol>
            {onboardingSteps.map((step, index) => (
              <li
                key={step}
                aria-current={step === state.step ? 'step' : undefined}
                data-complete={state.completedSteps.includes(step) || undefined}
              >
                <span aria-hidden="true">{index + 1}</span>
                {stepLabel(step)}
              </li>
            ))}
          </ol>
        </aside>
        <section className="onboarding-panel" aria-labelledby="onboarding-title">
          {error !== null && (
            <div className="validation-summary" role="alert">
              <strong>{uiMessage('onboarding-ui.1036')}</strong>
              <p>{error}</p>
            </div>
          )}
          {state.step === 'welcome' && (
            <WelcomeStep
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              heading={heading}
              onContinue={(next) => run(() => application.execute({ kind: 'start', draft: next }))}
            />
          )}
          {state.step === 'defaults' && (
            <DefaultsStep
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              heading={heading}
              onBack={navigateBack}
              onContinue={(next) =>
                run(() => application.execute({ kind: 'save_step', step: 'defaults', draft: next }))
              }
            />
          )}
          {state.step === 'context' && (
            <ContextStep
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              heading={heading}
              locked={{
                awake: state.artifacts.awakeContextId !== undefined,
                availability: state.artifacts.availabilityContextId !== undefined,
                boundary: state.artifacts.boundaryContextId !== undefined,
              }}
              onBack={navigateBack}
              onContinue={(next, skipped) =>
                run(() =>
                  application.execute({ kind: 'save_step', step: 'context', draft: next, skipped }),
                )
              }
            />
          )}
          {state.step === 'axes' && (
            <AxesStep
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              heading={heading}
              lockedCount={state.artifacts.axisIds.length}
              onBack={navigateBack}
              onContinue={(next, skipped) =>
                run(() =>
                  application.execute({ kind: 'save_step', step: 'axes', draft: next, skipped }),
                )
              }
            />
          )}
          {state.step === 'outcome' && (
            <OutcomeStep
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              heading={heading}
              locked={state.artifacts.outcomeId !== undefined}
              onBack={navigateBack}
              onContinue={(next, skipped) =>
                run(() =>
                  application.execute({ kind: 'save_step', step: 'outcome', draft: next, skipped }),
                )
              }
            />
          )}
          {state.step === 'week' && (
            <WeekStep
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              heading={heading}
              lockedCount={state.artifacts.commitments.length}
              onBack={navigateBack}
              onContinue={(next) =>
                run(() => application.execute({ kind: 'save_step', step: 'week', draft: next }))
              }
            />
          )}
          {state.step === 'handbook' && (
            <Handbook
              application={application}
              busy={busy}
              heading={heading}
              mode="onboarding"
              onBack={navigateBack}
              onRun={run}
              state={state}
              draft={draft}
            />
          )}
        </section>
      </div>
    </main>
  );
}

type StepProps = Readonly<{
  draft: OnboardingDraft;
  setDraft: (draft: OnboardingDraft) => void;
  busy: boolean;
  heading: React.RefObject<HTMLHeadingElement | null>;
  onBack?: () => Promise<void>;
}>;

function WelcomeStep(
  props: StepProps & { readonly onContinue: (draft: OnboardingDraft) => Promise<boolean> },
): ReactNode {
  const accounts = useAccountOptional();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void props.onContinue(props.draft);
  };
  return (
    <form onSubmit={submit}>
      <p className="eyebrow">{uiMessage('onboarding-ui.1037')}</p>
      <h1 id="onboarding-title" tabIndex={-1} ref={props.heading}>
        {uiMessage('onboarding-ui.1038')}
      </h1>
      <p className="lead">{uiMessage('onboarding-ui.1039')}</p>
      <div className="privacy-note">
        <strong>{uiMessage('onboarding-ui.1040')}</strong>
        {uiMessage('onboarding-ui.1041')}
      </div>
      <label className="field-label" htmlFor="preferred-name">
        {uiMessage('onboarding-ui.1042')}
        <span>{uiMessage('alignment.object-forms.664')}</span>
      </label>
      <input
        id="preferred-name"
        maxLength={80}
        value={props.draft.identity.preferredName}
        onChange={(event) =>
          props.setDraft({
            ...props.draft,
            identity: { ...props.draft.identity, preferredName: event.target.value },
          })
        }
      />
      <label className="field-label" htmlFor="locale">
        {uiMessage('onboarding-ui.1043')}
      </label>
      <input
        id="locale"
        value={props.draft.identity.locale}
        onChange={(event) =>
          props.setDraft({
            ...props.draft,
            identity: { ...props.draft.identity, locale: event.target.value },
          })
        }
        aria-describedby="locale-help"
      />
      <p className="field-help" id="locale-help">
        {uiMessage('onboarding-ui.1044')}
      </p>
      <div className="step-actions">
        <div className="welcome-actions">
          <button className="primary-button" disabled={props.busy} type="submit">
            {props.busy ? uiMessage('onboarding-ui.1045') : uiMessage('onboarding-ui.1046')}
          </button>
          {/* account sync: optional sign-in, only when this build has accounts; never a gate. */}
          <OnboardingSignIn />
        </div>
      </div>
      <p className="deferred-note">{welcomeAccountText(accountsOffered(accounts))}</p>
    </form>
  );
}

function DefaultsStep(
  props: StepProps & { readonly onContinue: (draft: OnboardingDraft) => Promise<boolean> },
): ReactNode {
  const defaults = props.draft.defaults;
  if (defaults === null) return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void props.onContinue(props.draft);
      }}
    >
      <p className="eyebrow">{uiMessage('onboarding-ui.1047')}</p>
      <h1 id="onboarding-title" tabIndex={-1} ref={props.heading}>
        {uiMessage('onboarding-ui.1048')}
      </h1>
      <p className="lead">{uiMessage('onboarding-ui.1049')}</p>
      <label className="field-label" htmlFor="time-zone">
        {uiMessage('onboarding-ui.1050')}
      </label>
      <input
        id="time-zone"
        required
        value={defaults.planningTimeZone}
        onChange={(event) =>
          props.setDraft({
            ...props.draft,
            defaults: { ...defaults, planningTimeZone: event.target.value },
          })
        }
        aria-describedby="time-zone-help"
      />
      <p className="field-help" id="time-zone-help">
        {uiMessage('onboarding-ui.1051')}
      </p>
      <div className="two-column-fields">
        <label>
          {uiMessage('onboarding-ui.1052')}
          <select
            value={defaults.weekStart}
            onChange={(event) =>
              props.setDraft({
                ...props.draft,
                defaults: { ...defaults, weekStart: event.target.value as Weekday },
              })
            }
          >
            {weekdayOptions.map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="compact-fieldset">
          <legend>{uiMessage('onboarding-ui.1053')}</legend>
          <div className="segmented-options">
            {(['12_hour', '24_hour'] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="time-format"
                  value={value}
                  checked={defaults.timeFormat === value}
                  onChange={() =>
                    props.setDraft({ ...props.draft, defaults: { ...defaults, timeFormat: value } })
                  }
                />
                <span>{value === '12_hour' ? uiMessage('app.2448') : uiMessage('app.2449')}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <StepActions busy={props.busy} onBack={props.onBack} next={uiMessage('onboarding-ui.2412')} />
    </form>
  );
}

function ContextStep(
  props: StepProps & {
    readonly locked: Readonly<{ awake: boolean; availability: boolean; boundary: boolean }>;
    readonly onContinue: (draft: OnboardingDraft, skipped: boolean) => Promise<boolean>;
  },
): ReactNode {
  const context = props.draft.context;
  const hasAny = Object.keys(context).length > 0;
  const setContext = (next: OnboardingDraft['context']): void =>
    props.setDraft({ ...props.draft, context: next });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void props.onContinue(props.draft, !hasAny);
      }}
    >
      <p className="eyebrow">{uiMessage('onboarding-ui.1054')}</p>
      <h1 id="onboarding-title" tabIndex={-1} ref={props.heading}>
        {uiMessage('onboarding-ui.1055')}
      </h1>
      <p className="lead">{uiMessage('onboarding-ui.1056')}</p>
      <OptionalSection
        label={uiMessage('onboarding-ui.1057')}
        enabled={context.awakeWindow !== undefined}
        locked={props.locked.awake}
        onToggle={(enabled) =>
          setContext(
            enabled
              ? { ...context, awakeWindow: { start: '07:00', end: '23:00' } }
              : omit(context, 'awakeWindow'),
          )
        }
      >
        {context.awakeWindow !== undefined && (
          <div className="two-column-fields">
            <label>
              {uiMessage('actions-ui.270')}
              <input
                type="time"
                value={context.awakeWindow.start}
                onChange={(event) =>
                  setContext({
                    ...context,
                    awakeWindow: { ...context.awakeWindow!, start: event.target.value },
                  })
                }
              />
            </label>
            <label>
              {uiMessage('actions-ui.271')}
              <input
                type="time"
                value={context.awakeWindow.end}
                onChange={(event) =>
                  setContext({
                    ...context,
                    awakeWindow: { ...context.awakeWindow!, end: event.target.value },
                  })
                }
              />
            </label>
          </div>
        )}
      </OptionalSection>
      <OptionalSection
        label={uiMessage('onboarding-ui.1058')}
        enabled={context.availability !== undefined}
        locked={props.locked.availability}
        onToggle={(enabled) =>
          setContext(
            enabled
              ? {
                  ...context,
                  availability: {
                    label: uiMessage('onboarding-ui.1059'),
                    weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
                    start: '09:00',
                    end: '17:00',
                    strength: 'soft',
                  },
                }
              : omit(context, 'availability'),
          )
        }
      >
        {context.availability !== undefined && (
          <AvailabilityFields draft={props.draft} setDraft={props.setDraft} />
        )}
      </OptionalSection>
      <OptionalSection
        label={uiMessage('onboarding-ui.1060')}
        enabled={context.boundary !== undefined}
        locked={props.locked.boundary}
        onToggle={(enabled) =>
          setContext(
            enabled
              ? { ...context, boundary: { text: '', strength: 'hard' } }
              : omit(context, 'boundary'),
          )
        }
      >
        {context.boundary !== undefined && (
          <>
            <label>
              {uiMessage('onboarding-ui.1061')}
              <textarea
                rows={2}
                maxLength={300}
                value={context.boundary.text}
                onChange={(event) =>
                  setContext({
                    ...context,
                    boundary: { ...context.boundary!, text: event.target.value },
                  })
                }
              />
            </label>
            <StrengthSelect
              value={context.boundary.strength}
              onChange={(strength) =>
                setContext({ ...context, boundary: { ...context.boundary!, strength } })
              }
            />
          </>
        )}
      </OptionalSection>
      <StepActions
        busy={props.busy}
        onBack={props.onBack}
        next={hasAny ? uiMessage('onboarding-ui.1062') : uiMessage('onboarding-ui.1063')}
      />
    </form>
  );
}

function AvailabilityFields({ draft, setDraft }: Pick<StepProps, 'draft' | 'setDraft'>): ReactNode {
  const availability = draft.context.availability;
  if (availability === undefined) return null;
  const update = (value: typeof availability): void =>
    setDraft({ ...draft, context: { ...draft.context, availability: value } });
  return (
    <>
      <label>
        {uiMessage('onboarding-ui.1064')}
        <input
          maxLength={80}
          value={availability.label}
          onChange={(event) => update({ ...availability, label: event.target.value })}
        />
      </label>
      <fieldset className="weekday-fieldset">
        <legend>{uiMessage('onboarding-ui.1065')}</legend>
        <div className="weekday-options">
          {weekdayOptions.map(([value, label]) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={availability.weekdays.includes(value)}
                onChange={(event) =>
                  update({
                    ...availability,
                    weekdays: event.target.checked
                      ? [...availability.weekdays, value]
                      : availability.weekdays.filter((day) => day !== value),
                  })
                }
              />
              <span>{label.slice(0, 3)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="two-column-fields">
        <label>
          {uiMessage('actions-ui.270')}
          <input
            type="time"
            value={availability.start}
            onChange={(event) => update({ ...availability, start: event.target.value })}
          />
        </label>
        <label>
          {uiMessage('actions-ui.271')}
          <input
            type="time"
            value={availability.end}
            onChange={(event) => update({ ...availability, end: event.target.value })}
          />
        </label>
      </div>
      <StrengthSelect
        value={availability.strength}
        onChange={(strength) => update({ ...availability, strength })}
      />
    </>
  );
}

function AxesStep(
  props: StepProps & {
    readonly lockedCount: number;
    readonly onContinue: (draft: OnboardingDraft, skipped: boolean) => Promise<boolean>;
  },
): ReactNode {
  const [custom, setCustom] = useState('');
  const axes = props.draft.axes;
  const toggle = (title: string): void => {
    const index = axes.indexOf(title);
    if (index >= 0 && index < props.lockedCount) return;
    props.setDraft({
      ...props.draft,
      axes:
        index >= 0
          ? axes.filter((axis) => axis !== title)
          : axes.length < 3
            ? [...axes, title]
            : axes,
    });
  };
  const addCustom = (): void => {
    const trimmed = custom.trim();
    if (trimmed !== '' && axes.length < 3) {
      props.setDraft({ ...props.draft, axes: [...axes, trimmed] });
      setCustom('');
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void props.onContinue(props.draft, axes.length === 0);
      }}
    >
      <p className="eyebrow">{uiMessage('onboarding-ui.1066')}</p>
      <h1 id="onboarding-title" tabIndex={-1} ref={props.heading}>
        {uiMessage('onboarding-ui.1067')}
      </h1>
      <p className="lead">{uiMessage('onboarding-ui.1068')}</p>
      <fieldset>
        <legend>{uiMessage('onboarding-ui.1069')}</legend>
        <div className="choice-grid">
          {[
            uiMessage('onboarding-ui.1070'),
            uiMessage('onboarding-ui.1071'),
            uiMessage('onboarding-ui.1072'),
          ].map((title) => {
            const index = axes.indexOf(title);
            return (
              <label key={title}>
                <input
                  type="checkbox"
                  checked={index >= 0}
                  disabled={
                    (index >= 0 && index < props.lockedCount) || (index < 0 && axes.length >= 3)
                  }
                  onChange={() => toggle(title)}
                />
                <span>{title}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {axes.length > 0 && (
        <div className="nested-fields" aria-label={uiMessage('onboarding-ui.1073')}>
          {axes.map((axis, index) => (
            <div className="axis-name-editor" key={index}>
              <label>
                {uiMessage('onboarding-ui.1074')}
                {index + 1}
                {uiMessage('onboarding-ui.1075')}
                <input
                  maxLength={80}
                  value={axis}
                  onChange={(event) =>
                    props.setDraft({
                      ...props.draft,
                      axes: replaceAt(axes, index, event.target.value),
                    })
                  }
                />
              </label>
              {index >= props.lockedCount &&
                ![
                  uiMessage('onboarding-ui.1070'),
                  uiMessage('onboarding-ui.1071'),
                  uiMessage('onboarding-ui.1072'),
                ].includes(axis) && (
                  <button
                    className="text-button destructive-text"
                    type="button"
                    onClick={() =>
                      props.setDraft({
                        ...props.draft,
                        axes: axes.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                  >
                    {uiMessage('onboarding-ui.1076')}
                  </button>
                )}
            </div>
          ))}
        </div>
      )}
      <div className="inline-entry">
        <label htmlFor="custom-axis">{uiMessage('onboarding-ui.1077')}</label>
        <div>
          <input
            id="custom-axis"
            maxLength={80}
            value={custom}
            disabled={axes.length >= 3}
            onChange={(event) => setCustom(event.target.value)}
          />
          <button
            type="button"
            disabled={axes.length >= 3 || custom.trim() === ''}
            onClick={addCustom}
          >
            {uiMessage('onboarding-ui.1078')}
          </button>
        </div>
      </div>
      <p className="field-help" aria-live="polite">
        {axes.length}
        {uiMessage('onboarding-ui.1079')}
        {props.lockedCount > 0 ? uiMessage('onboarding-ui.1080') : ''}
      </p>
      <StepActions
        busy={props.busy}
        onBack={props.onBack}
        next={axes.length === 0 ? uiMessage('onboarding-ui.1063') : uiMessage('onboarding-ui.1081')}
      />
    </form>
  );
}

function OutcomeStep(
  props: StepProps & {
    readonly locked: boolean;
    readonly onContinue: (draft: OnboardingDraft, skipped: boolean) => Promise<boolean>;
  },
): ReactNode {
  const enabled = props.draft.outcome !== null;
  const outcome = props.draft.outcome;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void props.onContinue(props.draft, !enabled);
      }}
    >
      <p className="eyebrow">{uiMessage('onboarding-ui.1082')}</p>
      <h1 id="onboarding-title" tabIndex={-1} ref={props.heading}>
        {uiMessage('onboarding-ui.1083')}
      </h1>
      <div className="example-pair">
        <p>
          <strong>{uiMessage('onboarding-ui.1084')}</strong>
          {uiMessage('onboarding-ui.1085')}
        </p>
        <p>
          <strong>{uiMessage('onboarding-ui.1086')}</strong>
          {uiMessage('onboarding-ui.1087')}
        </p>
      </div>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={props.locked}
          onChange={(event) =>
            props.setDraft({
              ...props.draft,
              outcome: event.target.checked ? { title: '', successDefinition: '' } : null,
            })
          }
        />
        <span>
          {props.locked ? uiMessage('onboarding-ui.1088') : uiMessage('onboarding-ui.1089')}
        </span>
      </label>
      {outcome !== null && (
        <div className="nested-fields">
          <label>
            {uiMessage('onboarding-ui.1090')}
            <input
              required
              maxLength={120}
              value={outcome.title}
              onChange={(event) =>
                props.setDraft({
                  ...props.draft,
                  outcome: { ...outcome, title: event.target.value },
                })
              }
            />
          </label>
          <label>
            {uiMessage('alignment.object-forms.661')}
            <textarea
              required
              rows={3}
              maxLength={500}
              value={outcome.successDefinition}
              onChange={(event) =>
                props.setDraft({
                  ...props.draft,
                  outcome: { ...outcome, successDefinition: event.target.value },
                })
              }
            />
          </label>
          {props.draft.axes.length > 0 && (
            <label>
              {uiMessage('onboarding-ui.1091')}
              <select
                value={outcome.axisIndex ?? ''}
                onChange={(event) =>
                  props.setDraft({
                    ...props.draft,
                    outcome:
                      event.target.value === ''
                        ? omit(outcome, 'axisIndex')
                        : { ...outcome, axisIndex: Number(event.target.value) },
                  })
                }
              >
                <option value="">{uiMessage('onboarding-ui.1092')}</option>
                {props.draft.axes.map((axis, index) => (
                  <option value={index} key={`${axis}-${index}`}>
                    {axis}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {uiMessage('onboarding-ui.1093')}
            <span>{uiMessage('alignment.object-forms.664')}</span>
            <input
              type="date"
              value={outcome.targetDate ?? ''}
              onChange={(event) =>
                props.setDraft({
                  ...props.draft,
                  outcome:
                    event.target.value === ''
                      ? omit(outcome, 'targetDate')
                      : { ...outcome, targetDate: event.target.value },
                })
              }
            />
          </label>
        </div>
      )}
      <StepActions
        busy={props.busy}
        onBack={props.onBack}
        next={enabled ? uiMessage('onboarding-ui.1094') : uiMessage('onboarding-ui.1063')}
      />
    </form>
  );
}

function WeekStep(
  props: StepProps & {
    readonly lockedCount: number;
    readonly onContinue: (draft: OnboardingDraft) => Promise<boolean>;
  },
): ReactNode {
  const week = props.draft.week;
  const updateWeek = (next: OnboardingDraft['week']): void =>
    props.setDraft({ ...props.draft, week: next });
  const add = (): void => {
    if (week.commitments.length < 3)
      updateWeek({
        ...week,
        commitments: [
          ...week.commitments,
          {
            title: '',
            date: todayInput(),
            start: '09:00',
            end: '10:00',
            strength: 'hard',
            confirmed: false,
          },
        ],
      });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void props.onContinue(props.draft);
      }}
    >
      <p className="eyebrow">{uiMessage('onboarding-ui.1095')}</p>
      <h1 id="onboarding-title" tabIndex={-1} ref={props.heading}>
        {uiMessage('onboarding-ui.1096')}
      </h1>
      <p className="lead">{uiMessage('onboarding-ui.1097')}</p>
      <label className="field-label" htmlFor="first-action">
        {uiMessage('onboarding-ui.1098')}
      </label>
      <input
        id="first-action"
        required
        maxLength={200}
        value={week.actionTitle}
        onChange={(event) => updateWeek({ ...week, actionTitle: event.target.value })}
        placeholder={uiMessage('onboarding-ui.1099')}
      />
      <div className="section-heading">
        <div>
          <h2>{uiMessage('onboarding-ui.1100')}</h2>
          <p>{uiMessage('onboarding-ui.1101')}</p>
        </div>
        <button type="button" onClick={add} disabled={week.commitments.length >= 3}>
          {uiMessage('onboarding-ui.1102')}
        </button>
      </div>
      {week.commitments.map((commitment, index) => (
        <fieldset className="commitment-editor" key={index}>
          <legend>
            {uiMessage('onboarding-ui.1103')}
            {index + 1}
          </legend>
          <label>
            {uiMessage('alignment.object-forms.649')}
            <input
              required
              maxLength={120}
              value={commitment.title}
              onChange={(event) =>
                updateWeek({
                  ...week,
                  commitments: replaceAt(week.commitments, index, {
                    ...commitment,
                    title: event.target.value,
                  }),
                })
              }
            />
          </label>
          <div className="three-column-fields">
            <label>
              {uiMessage('actions-ui.274')}
              <input
                required
                type="date"
                value={commitment.date}
                onChange={(event) =>
                  updateWeek({
                    ...week,
                    commitments: replaceAt(week.commitments, index, {
                      ...commitment,
                      date: event.target.value,
                    }),
                  })
                }
              />
            </label>
            <label>
              {uiMessage('actions-ui.270')}
              <input
                required
                type="time"
                value={commitment.start}
                onChange={(event) =>
                  updateWeek({
                    ...week,
                    commitments: replaceAt(week.commitments, index, {
                      ...commitment,
                      start: event.target.value,
                    }),
                  })
                }
              />
            </label>
            <label>
              {uiMessage('actions-ui.271')}
              <input
                required
                type="time"
                value={commitment.end}
                onChange={(event) =>
                  updateWeek({
                    ...week,
                    commitments: replaceAt(week.commitments, index, {
                      ...commitment,
                      end: event.target.value,
                    }),
                  })
                }
              />
            </label>
          </div>
          <label>
            {uiMessage('onboarding-ui.1104')}
            <select
              value={commitment.strength}
              onChange={(event) =>
                updateWeek({
                  ...week,
                  commitments: replaceAt(week.commitments, index, {
                    ...commitment,
                    strength: event.target.value as 'hard' | 'soft',
                  }),
                })
              }
            >
              <option value="hard">{uiMessage('onboarding-ui.1105')}</option>
              <option value="soft">{uiMessage('onboarding-ui.1106')}</option>
            </select>
          </label>
          <label className="confirmation-row">
            <input
              required
              type="checkbox"
              checked={commitment.confirmed}
              onChange={(event) =>
                updateWeek({
                  ...week,
                  commitments: replaceAt(week.commitments, index, {
                    ...commitment,
                    confirmed: event.target.checked,
                  }),
                })
              }
            />
            <span>{uiMessage('onboarding-ui.1107')}</span>
          </label>
          {index >= props.lockedCount ? (
            <button
              className="text-button destructive-text"
              type="button"
              onClick={() =>
                updateWeek({
                  ...week,
                  commitments: week.commitments.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              {uiMessage('onboarding-ui.1076')}
            </button>
          ) : (
            <p className="field-help">
              {uiMessage('onboarding-ui.1108')}
              {commitment.timeZone === undefined ? '' : ` (${commitment.timeZone})`}
              {uiMessage('onboarding-ui.1109')}
            </p>
          )}
        </fieldset>
      ))}
      <StepActions busy={props.busy} onBack={props.onBack} next={uiMessage('onboarding-ui.2413')} />
    </form>
  );
}

export function Handbook({
  application,
  busy,
  draft,
  heading,
  mode,
  onBack,
  onRun,
  state,
}: {
  readonly application: OnboardingApplication;
  readonly busy: boolean;
  readonly draft?: OnboardingDraft;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
  readonly mode: 'onboarding' | 'standalone';
  readonly onBack?: () => Promise<void>;
  readonly onRun: (
    operation: () => Promise<OnboardingApplicationResult<OnboardingState>>,
  ) => Promise<boolean>;
  readonly state: OnboardingState;
}): ReactNode {
  const lesson = Math.min(state.handbook.lesson, 3);
  const [sample, setSample] = useState({
    capture: '',
    scheduled: false,
    completed: false,
    review: '',
  });
  const lessonData = handbookLessons[lesson] ?? handbookLessons[0];
  const saveLesson = async (): Promise<void> => {
    if (!lessonReady(lesson, sample)) return;
    const completed = [...new Set([...state.handbook.completedLessons, lesson])];
    if (lesson === 3 && mode === 'onboarding' && draft !== undefined) {
      await onRun(() =>
        application.execute({ kind: 'complete', draft, handbookStatus: 'completed' }),
      );
      return;
    }
    await onRun(() =>
      application.execute({
        kind: 'save_handbook',
        status: lesson === 3 ? 'completed' : 'in_progress',
        lesson: Math.min(4, lesson + 1),
        completedLessons: completed,
      }),
    );
  };
  const skip = async (): Promise<void> => {
    if (mode === 'onboarding' && draft !== undefined)
      await onRun(() =>
        application.execute({ kind: 'complete', draft, handbookStatus: 'skipped' }),
      );
    else
      await onRun(() =>
        application.execute({
          kind: 'save_handbook',
          status: 'skipped',
          lesson: state.handbook.lesson,
          completedLessons: state.handbook.completedLessons,
        }),
      );
  };
  return (
    <div>
      <p className="eyebrow">{uiMessage('onboarding-ui.1110')}</p>
      <h1 id="onboarding-title" tabIndex={-1} ref={heading}>
        {uiMessage('onboarding-ui.1111')}
      </h1>
      <p className="lead">{uiMessage('onboarding-ui.1112')}</p>
      <div className="sandbox" aria-labelledby="sandbox-title">
        <div className="sandbox-header">
          <div>
            <span>{uiMessage('onboarding-ui.1113')}</span>
            <h2 id="sandbox-title">{lessonData.title}</h2>
          </div>
          <p>{lesson + 1} / 4</p>
        </div>
        <p>{lessonData.instructions}</p>
        {lesson === 0 && (
          <label>
            {uiMessage('onboarding-ui.1114')}
            <input
              value={sample.capture}
              onChange={(event) => setSample({ ...sample, capture: event.target.value })}
              placeholder={uiMessage('onboarding-ui.1115')}
            />
          </label>
        )}
        {lesson === 1 && (
          <button
            className={sample.scheduled ? 'sandbox-success' : ''}
            type="button"
            onClick={() => setSample({ ...sample, scheduled: !sample.scheduled })}
          >
            {sample.scheduled ? uiMessage('onboarding-ui.1116') : uiMessage('onboarding-ui.1117')}
          </button>
        )}
        {lesson === 2 && (
          <label className="confirmation-row">
            <input
              type="checkbox"
              checked={sample.completed}
              onChange={(event) => setSample({ ...sample, completed: event.target.checked })}
            />
            <span>{uiMessage('onboarding-ui.1118')}</span>
          </label>
        )}
        {lesson === 3 && (
          <label>
            {uiMessage('onboarding-ui.1119')}
            <textarea
              rows={3}
              value={sample.review}
              onChange={(event) => setSample({ ...sample, review: event.target.value })}
              placeholder={uiMessage('onboarding-ui.1120')}
            />
          </label>
        )}
        <p className="sandbox-boundary">{uiMessage('onboarding-ui.1121')}</p>
      </div>
      <div className="step-actions">
        <div>
          {onBack !== undefined && (
            <button disabled={busy} type="button" onClick={() => void onBack()}>
              {uiMessage('alignment.lifecycle-dialogs.531')}
            </button>
          )}
          <button className="text-button" disabled={busy} type="button" onClick={() => void skip()}>
            {mode === 'onboarding'
              ? uiMessage('onboarding-ui.1122')
              : uiMessage('onboarding-ui.1123')}
          </button>
        </div>
        <button
          className="primary-button"
          disabled={busy || !lessonReady(lesson, sample)}
          type="button"
          onClick={() => void saveLesson()}
        >
          {lesson === 3
            ? mode === 'onboarding'
              ? uiMessage('onboarding-ui.1124')
              : uiMessage('onboarding-ui.1125')
            : uiMessage('onboarding-ui.1126')}
        </button>
      </div>
      {mode === 'onboarding' && draft !== undefined && state.handbook.status === 'in_progress' && (
        <button
          className="text-button"
          type="button"
          onClick={() =>
            void onRun(() =>
              application.execute({ kind: 'complete', draft, handbookStatus: 'in_progress' }),
            )
          }
        >
          {uiMessage('onboarding-ui.1127')}
        </button>
      )}
    </div>
  );
}

const handbookLessons = [
  { title: uiMessage('actions-ui.223'), instructions: uiMessage('onboarding-ui.1128') },
  {
    title: uiMessage('onboarding-ui.1129'),
    instructions: uiMessage('onboarding-ui.1130'),
  },
  { title: uiMessage('actions-ui.257'), instructions: uiMessage('onboarding-ui.1131') },
  {
    title: uiMessage('app.783'),
    instructions: uiMessage('onboarding-ui.1132'),
  },
] as const;

function lessonReady(
  lesson: number,
  sample: { capture: string; scheduled: boolean; completed: boolean; review: string },
): boolean {
  return (
    [sample.capture.trim() !== '', sample.scheduled, sample.completed, sample.review.trim() !== ''][
      lesson
    ] ?? false
  );
}

function OptionalSection({
  children,
  enabled,
  label,
  locked = false,
  onToggle,
}: {
  readonly children: ReactNode;
  readonly enabled: boolean;
  readonly label: string;
  readonly locked?: boolean;
  readonly onToggle: (enabled: boolean) => void;
}): ReactNode {
  const id = useId();
  return (
    <section className="optional-section">
      <label className="toggle-row" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={enabled}
          disabled={locked}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {locked && <p className="field-help">{uiMessage('onboarding-ui.1133')}</p>}
      {enabled && <div className="nested-fields">{children}</div>}
    </section>
  );
}

function StrengthSelect({
  value,
  onChange,
}: {
  readonly value: 'hard' | 'soft' | 'unknown';
  readonly onChange: (value: 'hard' | 'soft' | 'unknown') => void;
}): ReactNode {
  return (
    <label>
      {uiMessage('onboarding-ui.1134')}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as 'hard' | 'soft' | 'unknown')}
      >
        <option value="hard">{uiMessage('onboarding-ui.1135')}</option>
        <option value="soft">{uiMessage('onboarding-ui.1136')}</option>
        <option value="unknown">{uiMessage('onboarding-ui.1137')}</option>
      </select>
    </label>
  );
}

function StepActions({
  busy,
  next,
  onBack,
}: {
  readonly busy: boolean;
  readonly next: string;
  readonly onBack?: (() => Promise<void>) | undefined;
}): ReactNode {
  return (
    <div className="step-actions">
      <div>
        {onBack !== undefined && (
          <button disabled={busy} type="button" onClick={() => void onBack()}>
            {uiMessage('alignment.lifecycle-dialogs.531')}
          </button>
        )}
      </div>
      <button className="primary-button" disabled={busy} type="submit">
        {busy ? uiMessage('account.conflicts-page.133') : next}
      </button>
    </div>
  );
}

function BrandStatic(): ReactNode {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        {uiMessage('app.827')}
      </span>
      <span>{uiMessage('app.828')}</span>
    </div>
  );
}
function stepLabel(step: OnboardingStep): string {
  return {
    welcome: uiMessage('onboarding-ui.1037'),
    defaults: uiMessage('onboarding-ui.1138'),
    context: uiMessage('onboarding-ui.1139'),
    axes: uiMessage('onboarding-ui.1140'),
    outcome: uiMessage('onboarding-ui.1141'),
    week: uiMessage('onboarding-ui.1095'),
    handbook: uiMessage('onboarding-ui.1142'),
  }[step];
}
function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _, ...rest } = value;
  void _;
  return rest;
}
function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  return values.map((current, currentIndex) => (currentIndex === index ? value : current));
}
function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}
