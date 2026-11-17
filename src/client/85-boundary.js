    /* A render error must not leave a blank, click-through window. The boundary
     * reports the error to the Host (content-free, for diagnosis) and offers a
     * close action that drops the overlay for this page. */
    function reportClientError(error, info) {
      try {
        void api('/diag/client-error', {
          method: 'POST',
          body: JSON.stringify({
            message: String(error?.message ?? error),
            stack: String(error?.stack ?? ''),
            componentStack: String(info?.componentStack ?? ''),
          }),
        });
      } catch {
        /* reporting is best-effort */
      }
    }

    class SourceLookBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null, closed: false };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        beacon('boundary', error?.message ?? String(error));
        reportClientError(error, info);
      }

      render() {
        if (this.state.closed) return null;
        if (this.state.error === null) return this.props.children;
        const panel = {
          position: 'fixed',
          inset: 0,
          zIndex: 55,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '24px',
          textAlign: 'center',
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          color: 'var(--dsw-alias-label-primary, #1f2328)',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        };
        return h('div', { style: panel },
          h('div', { style: { fontSize: '16px', fontWeight: 600 } }, 'SourceLook 渲染失败 / SourceLook failed to render'),
          h('div', { style: { maxWidth: '720px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #57606a)', wordBreak: 'break-word' } },
            String(this.state.error?.message ?? this.state.error)),
          h('button', {
            type: 'button',
            style: {
              height: '30px',
              padding: '0 12px',
              border: '1px solid var(--dsw-alias-border-l1, #d0d7de)',
              borderRadius: '7px',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
            },
            onClick: () => this.setState({ closed: true }),
          }, '关闭覆盖层 / Close overlay'),
        );
      }
    }
