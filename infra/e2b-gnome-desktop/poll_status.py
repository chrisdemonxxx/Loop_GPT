import os
import time

from dotenv import load_dotenv
from e2b import Template
from e2b.template.types import BuildInfo

load_dotenv()

info = BuildInfo(
    template_id='i2xxeb90xf7iskqkerzi',
    build_id='c2dd39d6-c5de-42da-a13a-c22555611f6f',
    name='loop-gnome-desktop',
    alias='loop-gnome-desktop',
)

deadline = time.time() + 40 * 60
while time.time() < deadline:
    try:
        status = Template.get_build_status(info)
        state = str(status.status)
        print(f"{time.strftime('%H:%M:%S')} {state}", flush=True)
        if 'READY' in state or 'ERROR' in state:
            if 'ERROR' in state and getattr(status, 'reason', None):
                print('REASON:', status.reason, flush=True)
            break
    except Exception as exc:
        print(f"{time.strftime('%H:%M:%S')} poll error: {exc}", flush=True)
    time.sleep(30)


