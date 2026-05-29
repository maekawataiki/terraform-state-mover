resource "aws_ecs_cluster" "dev_app" {
  name = "dev-app-cluster"
}

resource "aws_s3_bucket" "dev_data" {
  bucket = "dev-data-bucket"
}

resource "aws_iam_role" "dev_task" {
  name               = "dev-task-role"
  assume_role_policy = "{}"
}
