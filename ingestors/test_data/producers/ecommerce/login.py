from datetime import timedelta
from uuid import uuid4
import json

from producers.utils import get_meta, JSON_HEADER
from producers.base import BaseProducer


class EcommerceLoginProducer(BaseProducer):

    avg_emit_delta = timedelta(minutes=1)

    def get_data_point(self, time) -> dict:
        resp_body = {
            "success": True,
            "user_uuid": str(uuid4()),
            "api_key": str(uuid4()),
        }
        req_body = {
            "email": self.fake.free_email(),
            "password": self.fake.sentence(nb_words=5),
        }
        return {
            "request": {
                "url": {
                    "host": "test-ecommerce.metlo.com",
                    "path": "/login",
                    "parameters": []
                },
                "headers": [],
                "method": "POST",
                "body": json.dumps(req_body),
            },
            "response": {
                "status": 200,
                "headers": [JSON_HEADER],
                "body": json.dumps(resp_body),
            },
            "meta": get_meta(),
        }
